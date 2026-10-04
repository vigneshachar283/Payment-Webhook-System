import express from "express";
import dotenv from "dotenv";
import Stripe from "stripe";
import { prisma } from "./db.js";
import { stripe } from "./stripe.js";
import { redis } from "./redis.js";
import {
  connectRabbitMQ,
  getRabbitChannel,
  QUEUE_NAME,
} from "./rabbitmq.js";

dotenv.config();

const app = express();

const PORT = 4000;

/*
|--------------------------------------------------------------------------
| Stripe Webhook
|--------------------------------------------------------------------------
|
| Flow:
|
| Stripe
|   ↓
| Signature verification
|   ↓
| Redis idempotency
|   ↓
| PostgreSQL WebhookEvent
|   ↓
| RabbitMQ
|   ↓
| Return 200
|
| The actual payment processing is handled by worker.ts.
|
|--------------------------------------------------------------------------
*/

app.post(
  "/api/webhooks/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];

    // 1. Check Stripe signature
    if (!signature) {
      return res.status(400).send("Missing Stripe signature");
    }

    let event: Stripe.Event;

    // 2. Verify Stripe webhook signature
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!
      );
    } catch (error) {
      console.error(
        "Webhook signature verification failed:",
        error
      );

      return res.status(400).send("Invalid webhook signature");
    }

    console.log(
      "Verified Stripe event:",
      event.id,
      event.type
    );

    /*
    |--------------------------------------------------------------------------
    | Redis Idempotency
    |--------------------------------------------------------------------------
    */

    const idempotencyKey = `webhook:${event.id}`;

    const acquired = await redis.set(
      idempotencyKey,
      "processing",
      "EX",
      86400,
      "NX"
    );

    // Event already received
    if (acquired === null) {
      console.log(
        "Duplicate webhook detected by Redis:",
        event.id
      );

      return res.json({
        received: true,
        duplicate: true,
      });
    }

    console.log(
      "New webhook accepted by Redis:",
      event.id
    );

    try {
      /*
      |--------------------------------------------------------------------------
      | Store webhook event in PostgreSQL
      |--------------------------------------------------------------------------
      */

      const webhookEvent =
        await prisma.webhookEvent.create({
          data: {
            eventId: event.id,
            type: event.type,
            status: "RECEIVED",
            payload: JSON.parse(
              JSON.stringify(event)
            ),
          },
        });

      console.log(
        "Webhook event saved:",
        webhookEvent.eventId
      );

      /*
      |--------------------------------------------------------------------------
      | Handle Checkout Completion
      |--------------------------------------------------------------------------
      */

      if (
        event.type ===
        "checkout.session.completed"
      ) {
        const session =
          event.data.object as Stripe.Checkout.Session;

        const orderId =
          session.metadata?.orderId;

        // Make sure Stripe session contains our order ID
        if (!orderId) {
          console.error(
            "No orderId found in Stripe session metadata"
          );

          await prisma.webhookEvent.update({
            where: {
              eventId: event.id,
            },
            data: {
              status: "FAILED",
              error:
                "Missing orderId in Stripe session metadata",
            },
          });

          // Allow a future retry
          await redis.del(idempotencyKey);

          return res.status(400).json({
            error: "Missing orderId",
          });
        }

        /*
        |--------------------------------------------------------------------------
        | Publish Payment Job to RabbitMQ
        |--------------------------------------------------------------------------
        */

        const channel = getRabbitChannel();

        const paymentJob = {
          eventId: event.id,
          orderId,
          paymentIntentId:
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : null,
        };

        channel.sendToQueue(
          QUEUE_NAME,
          Buffer.from(
            JSON.stringify(paymentJob)
          ),
          {
            persistent: true,
          }
        );

        console.log(
          `Payment job queued for order ${orderId}`
        );
      }

      /*
      |--------------------------------------------------------------------------
      | Respond to Stripe
      |--------------------------------------------------------------------------
      |
      | IMPORTANT:
      | We do NOT mark the event as PROCESSED here.
      |
      | The worker will mark it PROCESSED after
      | successfully updating the order.
      |
      |--------------------------------------------------------------------------
      */

      return res.json({
        received: true,
        queued: true,
      });

    } catch (error: any) {
      /*
      |--------------------------------------------------------------------------
      | PostgreSQL Duplicate Protection
      |--------------------------------------------------------------------------
      */

      if (error?.code === "P2002") {
        console.log(
          "Duplicate webhook detected by PostgreSQL:",
          event.id
        );

        return res.json({
          received: true,
          duplicate: true,
        });
      }

      /*
      |--------------------------------------------------------------------------
      | Processing Failed
      |--------------------------------------------------------------------------
      |
      | Remove Redis lock so Stripe can retry the event.
      |
      |--------------------------------------------------------------------------
      */

      await redis.del(idempotencyKey);

      console.error(
        "Failed to process webhook:",
        error
      );

      return res.status(500).json({
        error: "Failed to process webhook",
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| JSON Middleware
|--------------------------------------------------------------------------
|
| This comes AFTER the Stripe webhook because Stripe requires
| the raw request body for signature verification.
|
|--------------------------------------------------------------------------
*/

app.use(express.json());

/*
|--------------------------------------------------------------------------
| Health Check
|--------------------------------------------------------------------------
*/

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
  });
});

/*
|--------------------------------------------------------------------------
| Create Order
|--------------------------------------------------------------------------
*/

app.post("/api/orders", async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        error: "Invalid amount",
      });
    }

    const order = await prisma.order.create({
      data: {
        amount,
        currency: "INR",
        status: "PENDING",
      },
    });

    return res.status(201).json(order);
  } catch (error) {
    console.error(
      "Failed to create order:",
      error
    );

    return res.status(500).json({
      error: "Failed to create order",
    });
  }
});

/*
|--------------------------------------------------------------------------
| Create Stripe Checkout Session
|--------------------------------------------------------------------------
*/

app.post(
  "/api/payments/checkout",
  async (req, res) => {
    try {
      const { orderId } = req.body;

      if (!orderId) {
        return res.status(400).json({
          error: "orderId is required",
        });
      }

      const order =
        await prisma.order.findUnique({
          where: {
            id: Number(orderId),
          },
        });

      if (!order) {
        return res.status(404).json({
          error: "Order not found",
        });
      }

      if (order.status !== "PENDING") {
        return res.status(400).json({
          error:
            "Order is not available for payment",
        });
      }

      const session =
        await stripe.checkout.sessions.create({
          mode: "payment",

          line_items: [
            {
              price_data: {
                currency: "inr",

                product_data: {
                  name: `Order #${order.id}`,
                },

                unit_amount: order.amount,
              },

              quantity: 1,
            },
          ],

          metadata: {
            orderId: String(order.id),
          },

          success_url:
            "http://localhost:3000/payment-success",

          cancel_url:
            "http://localhost:3000/payment-cancelled",
        });

      return res.json({
        checkoutUrl: session.url,
      });
    } catch (error) {
      console.error(
        "Failed to create checkout session:",
        error
      );

      return res.status(500).json({
        error:
          "Failed to create checkout session",
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| Start Server
|--------------------------------------------------------------------------
*/

async function startServer() {
  try {
    // Test Redis
    const redisResult = await redis.ping();

    console.log(
      "Redis ping:",
      redisResult
    );

    // Connect RabbitMQ
    await connectRabbitMQ();

    // Start Express
    app.listen(PORT, () => {
      console.log(
        `Server running on http://localhost:${PORT}`
      );
    });
  } catch (error) {
    console.error(
      "Failed to start server:",
      error
    );

    process.exit(1);
  }
}

startServer();
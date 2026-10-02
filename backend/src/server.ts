import express from "express";
import dotenv from "dotenv";
import Stripe from "stripe";
import { prisma } from "./db.js";
import { stripe } from "./stripe.js";

dotenv.config();

const app = express();


app.post(
  "/api/webhooks/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];

    if (!signature) {
      return res.status(400).send("Missing Stripe signature");
    }

    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!
      );
    } catch (error) {
      console.error("Webhook signature verification failed:", error);

      return res.status(400).send("Invalid webhook signature");
    }

    console.log(
      "Verified Stripe event:",
      event.id,
      event.type
    );

    try {
      const webhookEvent = await prisma.webhookEvent.create({
        data: {
          eventId: event.id,
          type: event.type,
          status: "RECEIVED",
          payload: JSON.parse(JSON.stringify(event)),
        },
      });

      console.log(
        "Webhook event saved:",
        webhookEvent.eventId
      );

      return res.json({
        received: true,
      });
    } catch (error) {
      console.error("Failed to save webhook event:", error);

      return res.status(500).json({
        error: "Failed to save webhook event",
      });
    }
  }
);

app.use(express.json());

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
  });
});

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
    console.error(error);

    return res.status(500).json({
      error: "Failed to create order",
    });
  }
});

app.post("/api/payments/checkout", async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({
        error: "orderId is required",
      });
    }

    const order = await prisma.order.findUnique({
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
        error: "Order is not available for payment",
      });
    }

    const session = await stripe.checkout.sessions.create({
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

      success_url: "http://localhost:3000/payment-success",

      cancel_url: "http://localhost:3000/payment-cancelled",
    });

    return res.json({
      checkoutUrl: session.url,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Failed to create checkout session",
    });
  }
});

const PORT = 4000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
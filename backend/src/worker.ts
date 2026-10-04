import dotenv from "dotenv";

import {
  connectRabbitMQ,
  QUEUE_NAME,
  RETRY_QUEUE_NAME,
  DLQ_QUEUE_NAME,
} from "./rabbitmq.js";

import { prisma } from "./db.js";
import { redis } from "./redis.js";

dotenv.config();

const MAX_RETRIES = 3;

async function startWorker() {
  try {
    const channel = await connectRabbitMQ();

    channel.prefetch(1);

    console.log("Payment worker started");

    channel.consume(
      QUEUE_NAME,
      async (message) => {
        if (!message) {
          return;
        }

        const retryCount = Number(
          message.properties.headers?.[
            "x-retry-count"
          ] || 0
        );

        try {
          const data = JSON.parse(
            message.content.toString()
          );

          console.log(
            "Received payment job:",
            data
          );

          const {
            eventId,
            orderId,
            paymentIntentId,
          } = data;

          // Update order
          await prisma.order.update({
            where: {
              id: Number(orderId),
            },

            data: {
              status: "PAID",
              providerPaymentId:
                paymentIntentId,
            },
          });

          // Mark webhook as processed
          await prisma.webhookEvent.update({
            where: {
              eventId,
            },

            data: {
              status: "PROCESSED",
              processedAt: new Date(),
              error: null,
            },
          });

          // Mark Redis idempotency key as processed
          await redis.set(
            `webhook:${eventId}`,
            "processed",
            "EX",
            86400
          );

          console.log(
            `Order ${orderId} marked as PAID`
          );

          console.log(
            `Webhook ${eventId} processed successfully`
          );

          channel.ack(message);
        } catch (error: any) {
          console.error(
            "Worker failed to process payment:",
            error
          );

          const nextRetryCount =
            retryCount + 1;

          /*
           * Retry
           */
          if (
            nextRetryCount <= MAX_RETRIES
          ) {
            console.log(
              `Retrying payment job (${nextRetryCount}/${MAX_RETRIES})`
            );

            channel.sendToQueue(
              RETRY_QUEUE_NAME,
              message.content,
              {
                persistent: true,

                headers: {
                  ...message.properties
                    .headers,

                  "x-retry-count":
                    nextRetryCount,
                },
              }
            );

            // Remove original message
            channel.ack(message);

            return;
          }

          /*
           * Maximum retries reached
           */
          console.error(
            `Maximum retries reached. Moving message to DLQ.`
          );

          try {
            const data = JSON.parse(
              message.content.toString()
            );

            /*
             * Mark webhook as failed
             */
            await prisma.webhookEvent.update({
              where: {
                eventId: data.eventId,
              },

              data: {
                status: "FAILED",

                error:
                  error?.message ||
                  "Payment processing failed after maximum retries",
              },
            });

            /*
             * Mark Redis state as failed
             */
            await redis.set(
              `webhook:${data.eventId}`,
              "failed",
              "EX",
              86400
            );
          } catch (dbError) {
            console.error(
              "Failed to update webhook failure status:",
              dbError
            );
          }

          /*
           * Send message to DLQ
           */
          channel.sendToQueue(
            DLQ_QUEUE_NAME,
            message.content,
            {
              persistent: true,

              headers: {
                ...message.properties
                  .headers,

                "x-retry-count":
                  retryCount,

                "x-failed": true,
              },
            }
          );

          // Remove original message
          channel.ack(message);

          console.log(
            "Message moved to Dead Letter Queue"
          );
        }
      }
    );
  } catch (error) {
    console.error(
      "Worker failed to start:",
      error
    );

    process.exit(1);
  }
}

startWorker();
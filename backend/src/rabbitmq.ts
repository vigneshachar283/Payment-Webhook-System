import amqp from "amqplib";

const RABBITMQ_URL =
  process.env.RABBITMQ_URL || "amqp://localhost:5672";

export const QUEUE_NAME = "payment-webhooks";
export const RETRY_QUEUE_NAME = "payment-webhooks.retry";
export const DLQ_QUEUE_NAME = "payment-webhooks.dlq";

export const MAIN_EXCHANGE = "payment.events";
export const ROUTING_KEY = "payment";

let channel: amqp.Channel;

export async function connectRabbitMQ() {
  const connection = await amqp.connect(RABBITMQ_URL);

  channel = await connection.createChannel();

  // Main exchange
  await channel.assertExchange(
    MAIN_EXCHANGE,
    "direct",
    {
      durable: true,
    }
  );

  // Main payment queue
  await channel.assertQueue(QUEUE_NAME, {
    durable: true,
  });

  await channel.bindQueue(
    QUEUE_NAME,
    MAIN_EXCHANGE,
    ROUTING_KEY
  );

  // Retry queue
  //
  // Messages stay here for 5 seconds.
  // After 5 seconds RabbitMQ automatically
  // sends them back to the main exchange.
  await channel.assertQueue(
    RETRY_QUEUE_NAME,
    {
      durable: true,

      arguments: {
        "x-message-ttl": 5000,

        "x-dead-letter-exchange":
          MAIN_EXCHANGE,

        "x-dead-letter-routing-key":
          ROUTING_KEY,
      },
    }
  );

  // Dead Letter Queue
  await channel.assertQueue(
    DLQ_QUEUE_NAME,
    {
      durable: true,
    }
  );

  console.log("RabbitMQ connected");
  console.log(
    `Queue ready: ${QUEUE_NAME}`
  );
  console.log(
    `Retry queue ready: ${RETRY_QUEUE_NAME}`
  );
  console.log(
    `DLQ ready: ${DLQ_QUEUE_NAME}`
  );

  return channel;
}

export function getRabbitChannel() {
  if (!channel) {
    throw new Error(
      "RabbitMQ channel is not initialized"
    );
  }

  return channel;
}
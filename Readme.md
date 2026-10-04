```markdown
# Idempotent Payment Webhook Processing System

A production-oriented payment webhook processing system built with **Node.js, TypeScript, PostgreSQL, Prisma, Redis, RabbitMQ, Stripe, and React**.

The main goal of this project is to handle unreliable and repeated payment webhooks safely and prevent duplicate business effects such as duplicate order fulfillment, wallet credits, or refunds.

> 🚧 This project is currently under development.

---

## 🎯 Problem Statement

Payment providers such as Stripe can send the same webhook event multiple times.

For example:

```text
Stripe
   ↓
checkout.session.completed
   ↓
Our Backend
```

Due to network failures, timeouts, or provider retries, the same event may arrive again:

```text
evt_123
evt_123
evt_123
evt_123
...
```

If the application processes every request independently, it could accidentally perform the same business operation multiple times.

For example:

```text
Payment: ₹1000

First webhook  → Wallet +₹1000
Second webhook → Wallet +₹1000 ❌
Third webhook  → Wallet +₹1000 ❌
```

This project is designed to prevent those duplicate business effects.

---

# 🏗️ Architecture

### Current implementation

```text
                                          ┌──────────────────┐
                         │      Client      │
                         │  Create Order    │
                         └────────┬─────────┘
                                  │
                                  ▼
                         ┌──────────────────┐
                         │   Express API    │
                         │   Node.js + TS   │
                         └────────┬─────────┘
                                  │
                         POST /api/orders
                                  │
                                  ▼
                         ┌──────────────────┐
                         │    PostgreSQL    │
                         │   Order=PENDING  │
                         └────────┬─────────┘
                                  │
                                  ▼
                      POST /payments/checkout
                                  │
                                  ▼
                         ┌──────────────────┐
                         │ Stripe Checkout  │
                         │     Session      │
                         └────────┬─────────┘
                                  │
                              Payment
                                  │
                                  ▼
                         ┌──────────────────┐
                         │      Stripe      │
                         └────────┬─────────┘
                                  │
                   checkout.session.completed
                                  │
                                  ▼
                  ┌──────────────────────────┐
                  │  POST /webhooks/stripe   │
                  │                          │
                  │  Verify Stripe Signature │
                  └────────────┬─────────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │        Redis        │
                    │                     │
                    │  SET webhook:event  │
                    │      NX + TTL       │
                    └──────────┬──────────┘
                               │
                    ┌──────────┴──────────┐
                    │                     │
                Duplicate               New
                    │                     │
                    ▼                     ▼
             ┌─────────────┐     ┌─────────────────┐
             │ Return 200  │     │   PostgreSQL    │
             │  Duplicate  │     │  WebhookEvent   │
             └─────────────┘     │ status=RECEIVED │
                                 └────────┬────────┘
                                          │
                                          ▼
                              ┌──────────────────────┐
                              │       RabbitMQ       │
                              │                      │
                              │ payment-webhooks     │
                              │     Main Queue       │
                              └──────────┬───────────┘
                                         │
                                  ACK webhook
                                  quickly to Stripe
                                         │
                                         ▼
                              ┌──────────────────────┐
                              │  Background Worker   │
                              └──────────┬───────────┘
                                         │
                                Process Payment Job
                                         │
                           ┌─────────────┴─────────────┐
                           │                           │
                        SUCCESS                     FAILURE
                           │                           │
                           ▼                           ▼
                ┌─────────────────────┐     ┌────────────────────┐
                │     PostgreSQL      │     │    Retry Queue     │
                │                     │     │                    │
                │ Order → PAID        │     │   Wait 5 seconds   │
                │ Webhook → PROCESSED │     └─────────┬──────────┘
                └──────────┬──────────┘               │
                           │                           ▼
                           │                    Main Queue Again
                           │                           │
                           │                      Retry Worker
                           │                           │
                           │                    Maximum 3 retries
                           │                           │
                           │              ┌────────────┴───────────┐
                           │              │                        │
                           │           SUCCESS                   FAILURE
                           │              │                        │
                           │              ▼                        ▼
                           │         Processed              ┌─────────────┐
                           │                                │     DLQ     │
                           │                                │ Dead Letter │
                           │                                │    Queue    │
                           │                                └─────────────┘
                           │
                           ▼
                  ┌─────────────────┐
                  │      Redis      │
                  │                 │
                  │    processed    │
                  │   TTL = 24 hrs  │
                  └─────────────────┘
```

### Planned final architecture

```text
                         ┌──────────────┐
                         │    Stripe    │
                         └──────┬───────┘
                                │
                                ▼
                    ┌────────────────────┐
                    │ Webhook Receiver   │
                    │ Node.js + Express  │
                    └──────────┬─────────┘
                               │
                       Verify Signature
                               │
                               ▼
                    ┌────────────────────┐
                    │       Redis        │
                    │ Fast Duplicate     │
                    │ Check              │
                    └──────────┬─────────┘
                               │
                               ▼
                    ┌────────────────────┐
                    │    PostgreSQL      │
                    │ Source of Truth    │
                    └──────────┬─────────┘
                               │
                               ▼
                    ┌────────────────────┐
                    │     RabbitMQ       │
                    │  Message Broker    │
                    └──────────┬─────────┘
                               │
                               ▼
                    ┌────────────────────┐
                    │ Background Worker  │
                    └──────────┬─────────┘
                               │
                  ┌────────────┴────────────┐
                  ▼                         ▼
           Order Processing          Wallet Processing
                  │                         │
                  └────────────┬────────────┘
                               ▼
                         Outbox Events
                               │
                               ▼
                     Downstream Services
```

---

# ✨ Features

## Implemented

- Node.js + TypeScript backend
- Express REST API
- PostgreSQL database
- Prisma ORM
- Dockerized PostgreSQL
- Order creation
- Stripe Checkout integration
- Stripe test-mode payments
- Stripe webhook endpoint
- Stripe webhook signature verification
- Raw webhook body handling
- Webhook event persistence
- Unique webhook event ID constraint
- Webhook event lifecycle fields

## Planned

- Redis-based fast duplicate detection
- PostgreSQL-backed idempotency
- RabbitMQ message broker
- Asynchronous payment processing
- Worker service
- Wallet service
- Payment/refund processing
- Retry mechanism
- Dead-letter queue/table
- Outbox pattern
- Concurrent webhook testing
- React monitoring dashboard
- Webhook replay functionality
- Duplicate-event metrics

---

# 🛠️ Tech Stack

### Backend

- Node.js
- TypeScript
- Express.js

### Database

- PostgreSQL
- Prisma ORM

### Infrastructure

- Docker
- Docker Compose

### Payment Provider

- Stripe Test Mode
- Stripe Webhooks
- Stripe CLI

### Planned Infrastructure

- Redis
- RabbitMQ

### Frontend

- React

---

# 📁 Project Structure

```text
payment-webhook-system/
│
├── docker-compose.yml
├── README.md
│
└── backend/
    │
    ├── prisma/
    │   ├── migrations/
    │   └── schema.prisma
    │
    ├── src/
    │   ├── db.ts
    │   ├── server.ts
    │   ├── stripe.ts
    │   ├── redis.ts
    │   ├── rabbitmq.ts
    │   └── worker.ts
    │
    ├── .env
    ├── package.json
    ├── package-lock.json
    ├── prisma.config.ts
    └── tsconfig.json
```

---

# 🗄️ Database Schema

## Order

```text
Order
--------------------------------
id
amount
currency
status
providerPaymentId
createdAt
updatedAt
```

Example:

```text
id: 1
amount: 100000
currency: INR
status: PENDING
```

The amount is stored in the smallest currency unit.

For INR:

```text
₹1000 = 100000 paise
```

This avoids floating-point problems when handling money.

---

## WebhookEvent

```text
WebhookEvent
--------------------------------
id
eventId
type
status
payload
receivedAt
processedAt
error
```

The important constraint is:

```prisma
eventId String @unique
```

This prevents the database from storing the same Stripe event ID multiple times.

---

# 🔐 Webhook Security

The webhook endpoint is:

```text
POST /api/webhooks/stripe
```

Stripe signs webhook requests.

The backend verifies the signature using:

```typescript
stripe.webhooks.constructEvent(
  req.body,
  signature,
  process.env.STRIPE_WEBHOOK_SECRET
);
```

The webhook uses:

```typescript
express.raw({
  type: "application/json"
});
```

instead of normal JSON parsing because Stripe signature verification requires the original raw request body.

---

# 💳 Payment Flow

The current payment flow is:

```text
1. Create Order
        ↓
2. Order stored as PENDING
        ↓
3. Create Stripe Checkout Session
        ↓
4. Customer completes payment
        ↓
5. Stripe generates webhook event
        ↓
6. Stripe CLI forwards event locally
        ↓
7. Backend verifies Stripe signature
        ↓
8. WebhookEvent stored in PostgreSQL
```

Important:

The following URL:

```text
/payment-success
```

does **not** determine whether the payment succeeded.

The backend relies on the verified Stripe webhook for payment confirmation.

---

# 🚀 Getting Started

## 1. Clone the repository

```bash
git clone <your-repository-url>

cd payment-webhook-system
```

---

## 2. Start PostgreSQL

From the project root:

```bash
docker compose up -d
```

Check that PostgreSQL is running:

```bash
docker ps
```

---

## 3. Install backend dependencies

```bash
cd backend
npm install
```

---

## 4. Configure environment variables

Create:

```text
backend/.env
```

Add:

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/payment_system"

STRIPE_SECRET_KEY="your_stripe_test_secret"

STRIPE_WEBHOOK_SECRET="your_stripe_webhook_secret"
```

Never commit `.env` to Git.

---

# 🗃️ Setup Database

Run:

```bash
npx prisma migrate dev
```

Then:

```bash
npx prisma generate
```

To inspect the database:

```bash
npx prisma studio
```

---

# ▶️ Start Backend

```bash
npm run dev
```

Backend runs at:

```text
http://localhost:4000
```

Health check:

```text
GET /health
```

---

# 🔗 Stripe CLI

Install the Stripe CLI and authenticate:

```bash
stripe login
```

Then forward the required webhook event:

```bash
stripe listen \
  --events checkout.session.completed \
  --forward-to localhost:4000/api/webhooks/stripe
```

The CLI provides a webhook signing secret.

Add that value to:

```env
STRIPE_WEBHOOK_SECRET="whsec_..."
```

---

# 🧪 Testing

## Create an order

PowerShell:

```powershell
Invoke-RestMethod `
  -Uri http://localhost:4000/api/orders `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"amount":100000}'
```

---

## Create Stripe Checkout Session

```powershell
$response = Invoke-RestMethod `
  -Uri http://localhost:4000/api/payments/checkout `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"orderId":1}'
```

Open the Checkout page:

```powershell
Start-Process $response.checkoutUrl
```

Use Stripe's test card:

```text
4242 4242 4242 4242
```

with a future expiry date and any valid CVC.

---

# 🔄 Webhook Testing

After completing the payment, Stripe CLI should show:

```text
checkout.session.completed [evt_...]
<-- [200] POST http://localhost:4000/api/webhooks/stripe
```

The backend should log:

```text
Verified Stripe event: evt_... checkout.session.completed
```

The event is then stored in:

```text
WebhookEvent
```

with:

```text
status = RECEIVED
```

---

# 🧠 Key Engineering Concepts

This project is designed to demonstrate practical backend and distributed-systems concepts.

### Idempotency

Handling the same operation multiple times without producing duplicate business effects.

### Database Constraints

Using:

```prisma
eventId String @unique
```

as a durable duplicate-event protection mechanism.

### Webhook Signature Verification

Verifying that an incoming webhook was genuinely signed by Stripe.

### Raw Request Bodies

Understanding why some webhook providers require access to the original request body.

### Redis

Planned fast duplicate detection layer.

Redis will be treated as an optimization rather than the final source of truth.

### Message Queues

RabbitMQ will decouple webhook ingestion from payment processing.

### Asynchronous Processing

The webhook receiver should acknowledge the event quickly while background workers handle business processing.

### Retry Handling

Temporary failures should be retried rather than immediately losing the event.

### Dead-Letter Handling

Repeatedly failing events should be isolated for investigation or replay.

### Outbox Pattern

Ensures database state changes and downstream event publishing can be made reliable together.

### Distributed-System Reliability

The project explores failures caused by:

- duplicate delivery
- network failures
- service crashes
- database failures
- message delivery failures
- worker failures
- retries
- out-of-order events

---

# 🗺️ Development Roadmap

### Phase 1 — Foundation

- [x] Node.js
- [x] TypeScript
- [x] Express
- [x] PostgreSQL
- [x] Docker
- [x] Prisma
- [x] Order API

### Phase 2 — Stripe Integration

- [x] Stripe SDK
- [x] Checkout Session
- [x] Stripe test payment
- [x] Stripe CLI
- [x] Webhook endpoint
- [x] Signature verification

### Phase 3 — Idempotency

- [x] WebhookEvent table
- [x] Unique event ID
- [x] Duplicate event handling
- [x] Redis fast-path duplicate detection
- [x] Exactly-once business effects backed by database constraints

### Phase 4 — Async Processing

- [x] RabbitMQ
- [x] Exchanges
- [x] Queues
- [x] Routing keys
- [x] Worker
- [x] Acknowledgements
- [x] Durable messages

### Phase 5 — Reliability

- [x] Retry mechanism
- [ ] Failed state
- [ ] Dead-letter handling
- [ ] Event replay
- [ ] Outbox pattern

### Phase 6 — Testing

- [ ] Duplicate webhook tests
- [ ] Concurrent webhook tests
- [ ] 500 identical webhook requests
- [ ] Database consistency checks
- [ ] Failure/recovery tests

### Phase 7 — Dashboard

- [ ] React dashboard
- [ ] Live event feed
- [ ] Processing status
- [ ] Duplicate count
- [ ] Failed events
- [ ] Webhook replay
- [ ] Basic monitoring

---

# 🎯 Project Goal

The final system should demonstrate that a payment event can safely pass through an unreliable distributed environment while maintaining correct business state.

The key requirement is:

```text
Same payment event
        ↓
received 1 time
        OR
received 10 times
        OR
received 500 times
        ↓
ONE correct business effect
```

The system should be designed around **idempotency, durable state, asynchronous processing, retries, and failure recovery** rather than simply creating CRUD endpoints.

---

# 👨‍💻 Author

**Vignesh**


```


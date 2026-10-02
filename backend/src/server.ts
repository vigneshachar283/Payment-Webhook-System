import express from "express";
import dotenv from "dotenv";
import { prisma } from "./db.js";

dotenv.config();

const app = express();

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

const PORT = 4000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
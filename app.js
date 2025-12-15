import express from 'express';
import { config } from 'dotenv';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import fileUpload from 'express-fileupload';
import { createTables } from './utils/createTables.js';
import { errorMiddleware } from './middlewares/errorMiddleware.js';
import authRoutes from './router/authRoutes.js';
import productRoutes from './router/productRoutes.js';
import adminRouter from "./router/adminRoutes.js";
import orderRouter from "./router/orderRoutes.js";
import Stripe from "stripe";
import database from "./database/db.js";

const app = express();

config({ path: './config/config.env' });

app.use(
  cors({
    origin: [process.env.FRONTEND_URL, process.env.DASHBOARD_URL],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
  })
);

app.post(
  "/api/v1/payment/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = Stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      return res.status(400).send(`Webhook Error: ${error.message || error}`);
    }

    // Handling the Event

    if (event.type === "payment_intent.succeeded") {
      const paymentIntentId = event.data.object.id;
      console.log("Payment succeeded webhook received for payment intent:", paymentIntentId);
      
      try {
        // FINDING AND UPDATED PAYMENT
        const updatedPaymentStatus = "Paid";
        const paymentTableUpdateResult = await database.query(
          `UPDATE payments SET payment_status = $1 WHERE payment_intent_id = $2 RETURNING *`,
          [updatedPaymentStatus, paymentIntentId]
        );
        
        if (paymentTableUpdateResult.rows.length === 0) {
          console.error("No payment record found for payment_intent_id:", paymentIntentId);
          return res.status(404).send("Payment record not found");
        }
        
        console.log("Payment updated successfully for order:", paymentTableUpdateResult.rows[0].order_id);
        
        const orderId = paymentTableUpdateResult.rows[0].order_id;
        
        // Update the order to mark it as paid
        const orderUpdateResult = await database.query(
          `UPDATE orders SET paid_at = NOW() WHERE id = $1 RETURNING *`,
          [orderId]
        );
        
        console.log("✅ Order marked as paid:", orderUpdateResult.rows[0]);

        // Reduce Stock For Each Product

        const { rows: orderedItems } = await database.query(
          `
            SELECT product_id, quantity FROM order_items WHERE order_id = $1
          `,
          [orderId]
        );

        // For each ordered item, reduce the product stock
        for (const item of orderedItems) {
          await database.query(
            `UPDATE products SET stock = stock - $1 WHERE id = $2`,
            [item.quantity, item.product_id]
          );
        }
      } catch (error) {
        return res
          .status(500)
          .send(`Error updating paid_at timestamp in orders table.`);
      }
    }
    res.status(200).send({ received: true });
  }
);

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  fileUpload({
    tempFileDir: './uploads',
    useTempFiles: true,
  })
);

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/product', productRoutes);
app.use("/api/v1/admin", adminRouter);
app.use("/api/v1/order", orderRouter);

createTables();

app.use(errorMiddleware);

export default app;
import mongoose from "mongoose";
import { config } from "./config.js";

export async function connectDB() {
  await mongoose.connect(config.mongodbUri, { dbName: config.mongodbDb });
  console.log(`Connected to MongoDB (db: ${config.mongodbDb})`);
}

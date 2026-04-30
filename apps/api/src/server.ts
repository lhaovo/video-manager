import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { config } from "./config.js";
import { migrate } from "./db.js";
import { registerRoutes } from "./routes.js";

migrate();

const app = Fastify({
  logger: true
});

await app.register(cors, {
  origin: [config.webOrigin, "http://127.0.0.1:5173"],
  methods: ["GET", "POST", "PATCH", "DELETE"]
});
await app.register(multipart, {
  limits: {
    fileSize: 20 * 1024 * 1024 * 1024
  }
});

await registerRoutes(app);

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

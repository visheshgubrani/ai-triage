import { z } from "zod";
import type { CategoryTemplate } from "../types";
import { field } from "./field";

export const supportRequest: CategoryTemplate = {
  category: "support_request",
  version: 1,
  schema: z
    .object({
      customer_name: field(z.string().min(1), "Name of the customer asking for help.", { quote: true }).optional(),
      customer_email: field(z.email(), "Email address of the customer (usually the sender).", { quote: true }),
      product: field(z.string().min(1), "Product or service the request is about.", { quote: true }).optional(),
      order_id: field(z.string().min(1), "Order, account or ticket number the customer cites.", {
        quote: true,
      }).optional(),
      issue_summary: field(z.string().min(1), "One-sentence summary of the problem, in your own words."),
      severity: field(
        z.enum(["low", "medium", "high", "urgent"]),
        "urgent: outage, safety or legal risk, or an explicit hard deadline; high: the customer is blocked; medium: degraded but workable; low: a question or minor issue.",
      ),
      requested_action: field(
        z.enum(["refund", "replacement", "repair", "information", "account_change", "cancellation", "other"]),
        "What the customer asks the company to do.",
      ),
    })
    .meta({ description: "A customer or user asking for help with a product, order, account or service." }),
  comparators: {
    customer_name: "normalized",
    customer_email: "normalized",
    product: "normalized",
    order_id: "exact",
    issue_summary: "normalized",
    severity: "exact",
    requested_action: "exact",
  },
  rules: [],
};

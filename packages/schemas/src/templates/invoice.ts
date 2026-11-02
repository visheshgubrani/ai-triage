import { z } from "zod";
import type { CategoryTemplate } from "../types";
import { CENT, field, num, str } from "./field";

const lineItem = z.object({
  description: field(z.string(), "What was billed, as written."),
  quantity: field(z.number(), "Quantity, if stated.").optional(),
  unit_price: field(z.number(), "Price per unit, if stated.").optional(),
  amount: field(z.number(), "Line total."),
});

export const invoice: CategoryTemplate = {
  category: "invoice",
  version: 1,
  schema: z
    .object({
      vendor_name: field(z.string().min(1), "Name of the company or person issuing the invoice.", { quote: true }),
      invoice_number: field(z.string().min(1), "The invoice's identifier as printed.", { quote: true }),
      invoice_date: field(z.iso.date(), "Issue date, as YYYY-MM-DD.", { quote: true }),
      due_date: field(z.iso.date(), "Payment due date, as YYYY-MM-DD.", { quote: true }).optional(),
      currency: field(
        z.string().regex(/^[A-Z]{3}$/),
        "ISO 4217 code such as USD or EUR. Infer it from a symbol only when unambiguous.",
      ).optional(),
      subtotal: field(z.number(), "Amount before tax, as a plain number.", { quote: true }).optional(),
      tax: field(z.number(), "Total tax, as a plain number.", { quote: true }).optional(),
      total: field(z.number(), "Total amount due, as a plain number.", { quote: true }),
      po_number: field(z.string().min(1), "Purchase order number referenced by the invoice.", {
        quote: true,
      }).optional(),
      line_items: field(z.array(lineItem), "Each billed line, in document order.").optional(),
    })
    .meta({ description: "A bill requesting payment for goods or services, from a vendor to the recipient." }),
  comparators: {
    vendor_name: "normalized",
    invoice_number: "exact",
    invoice_date: "date",
    due_date: "date",
    currency: "exact",
    subtotal: "amount",
    tax: "amount",
    total: "amount",
    po_number: "normalized",
    line_items: "set_f1",
  },
  rules: [
    {
      id: "line_items_sum",
      description: "Line item amounts add up to the subtotal (or to the total minus tax).",
      check: (v) => {
        const items = Array.isArray(v.line_items) ? v.line_items : [];
        const total = num(v.total);
        if (items.length === 0 || total === undefined) return undefined;
        const base = num(v.subtotal) ?? total - (num(v.tax) ?? 0);
        const sum = items.reduce((acc: number, item) => acc + (num((item as { amount?: unknown }).amount) ?? 0), 0);
        return Math.abs(sum - base) <= CENT;
      },
    },
    {
      id: "totals_add_up",
      description: "Subtotal plus tax equals the total.",
      check: (v) => {
        const [subtotal, tax, total] = [num(v.subtotal), num(v.tax), num(v.total)];
        if (subtotal === undefined || tax === undefined || total === undefined) return undefined;
        return Math.abs(subtotal + tax - total) <= CENT;
      },
    },
    {
      id: "due_after_issue",
      description: "The due date is not before the issue date.",
      check: (v) => {
        const [issued, due] = [str(v.invoice_date), str(v.due_date)];
        return issued && due ? due >= issued : undefined;
      },
    },
  ],
};

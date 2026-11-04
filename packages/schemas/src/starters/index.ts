import type { CategoryDefinitionInput } from "../definition";

type FieldInput = CategoryDefinitionInput["fields"][number];

// The starter gallery in Settings → Categories: common document types a tenant can adopt as is or
// edit before saving. They are only suggestions; nothing runs until one is saved as a version.

export interface Starter {
  id: string;
  title: string;
  definition: CategoryDefinitionInput;
}

const lineItems: FieldInput = {
  name: "line_items",
  type: "object_list",
  description: "Each line, in document order.",
  itemFields: [
    { name: "description", type: "text", description: "What the line is for, as written.", required: true },
    { name: "quantity", type: "number", description: "Quantity, if stated." },
    { name: "amount", type: "amount", description: "Line total, as a plain number." },
  ],
};

const currency: FieldInput = {
  name: "currency",
  type: "text",
  description: "ISO 4217 code such as USD or EUR. Infer it from a symbol only when unambiguous.",
  comparator: "exact",
};

export const STARTERS: Starter[] = [
  {
    id: "purchase_order",
    title: "Purchase order",
    definition: {
      name: "purchase_order",
      label: "Purchase order",
      description: "A buyer's order to a supplier for goods or services, with a PO number, before any invoice.",
      examples: ["PO 4500012345 for 200 units of part A-17", "New purchase order from Northwind Traders"],
      fields: [
        {
          name: "po_number",
          type: "text",
          description: "The purchase order number as printed.",
          required: true,
          quote: true,
          comparator: "exact",
        },
        {
          name: "buyer_name",
          type: "text",
          description: "The company placing the order.",
          required: true,
          quote: true,
        },
        { name: "supplier_name", type: "text", description: "The company the order is addressed to.", quote: true },
        { name: "order_date", type: "date", description: "Order date, as YYYY-MM-DD.", quote: true },
        { name: "delivery_date", type: "date", description: "Requested delivery date, as YYYY-MM-DD.", quote: true },
        currency,
        { name: "total", type: "amount", description: "Order total, as a plain number.", quote: true },
        lineItems,
      ],
    },
  },
  {
    id: "receipt",
    title: "Receipt",
    definition: {
      name: "receipt",
      label: "Receipt",
      description: "Proof of a payment already made: a store, card or online receipt, nothing left to pay.",
      examples: ["Your receipt from Blue Bottle Coffee", "Payment received, thank you"],
      fields: [
        { name: "merchant_name", type: "text", description: "Who was paid.", required: true, quote: true },
        {
          name: "purchase_date",
          type: "date",
          description: "Date of the payment, as YYYY-MM-DD.",
          required: true,
          quote: true,
        },
        currency,
        { name: "total", type: "amount", description: "Amount paid, as a plain number.", required: true, quote: true },
        { name: "tax", type: "amount", description: "Tax included, as a plain number.", quote: true },
        {
          name: "payment_method",
          type: "enum",
          description: "How it was paid.",
          enum: ["card", "cash", "bank_transfer", "other"],
        },
      ],
    },
  },
  {
    id: "credit_note",
    title: "Credit note",
    definition: {
      name: "credit_note",
      label: "Credit note",
      description: "A vendor's credit against an earlier invoice, reducing what the recipient owes.",
      examples: ["Credit memo CN-2041 for invoice INV-1987"],
      fields: [
        {
          name: "vendor_name",
          type: "text",
          description: "The company issuing the credit.",
          required: true,
          quote: true,
        },
        {
          name: "credit_note_number",
          type: "text",
          description: "The credit note's identifier.",
          required: true,
          quote: true,
          comparator: "exact",
        },
        {
          name: "original_invoice_number",
          type: "text",
          description: "The invoice the credit applies to.",
          quote: true,
          comparator: "exact",
        },
        { name: "issue_date", type: "date", description: "Issue date, as YYYY-MM-DD.", quote: true },
        currency,
        {
          name: "amount",
          type: "amount",
          description: "Credited amount, as a positive plain number.",
          required: true,
          quote: true,
        },
        { name: "reason", type: "long_text", description: "Why the credit was issued, in a sentence." },
      ],
    },
  },
  {
    id: "shipping_notice",
    title: "Shipping notice",
    definition: {
      name: "shipping_notice",
      label: "Shipping notice",
      description: "Notice that an order has shipped or will arrive: carrier, tracking number and delivery estimate.",
      examples: ["Your order has shipped: tracking 1Z999AA10123456784", "Advance shipping notice for PO 7781"],
      fields: [
        { name: "carrier", type: "text", description: "The shipping company.", quote: true },
        {
          name: "tracking_number",
          type: "text",
          description: "The tracking number as printed.",
          required: true,
          quote: true,
          comparator: "exact",
        },
        {
          name: "order_reference",
          type: "text",
          description: "The order or PO number it ships against.",
          quote: true,
          comparator: "exact",
        },
        { name: "ship_date", type: "date", description: "Ship date, as YYYY-MM-DD.", quote: true },
        {
          name: "estimated_delivery",
          type: "date",
          description: "Expected delivery date, as YYYY-MM-DD.",
          quote: true,
        },
        { name: "package_count", type: "number", description: "Number of packages, if stated." },
      ],
    },
  },
  {
    id: "refund_request",
    title: "Refund request",
    definition: {
      name: "refund_request",
      label: "Refund request",
      description: "A customer asking for their money back for an order, a charge or a subscription.",
      examples: ["I'd like a refund for order #10422", "Charged twice, please refund"],
      fields: [
        { name: "customer_email", type: "email", description: "The customer's email address.", required: true },
        {
          name: "order_reference",
          type: "text",
          description: "The order, invoice or charge it concerns.",
          quote: true,
          comparator: "exact",
        },
        { name: "amount", type: "amount", description: "Amount to refund, if stated, as a plain number.", quote: true },
        currency,
        {
          name: "reason",
          type: "enum",
          description: "The main reason given.",
          required: true,
          enum: ["damaged", "not_received", "wrong_item", "duplicate_charge", "cancelled", "other"],
        },
        {
          name: "summary",
          type: "long_text",
          description: "What the customer wants, in one or two sentences.",
          required: true,
        },
      ],
    },
  },
  {
    id: "job_application",
    title: "Job application",
    definition: {
      name: "job_application",
      label: "Job application",
      description: "A candidate applying for a position, usually with a CV or resume attached.",
      examples: ["Application for Senior Accountant", "Resume attached for the warehouse role"],
      fields: [
        {
          name: "candidate_name",
          type: "text",
          description: "The applicant's full name.",
          required: true,
          quote: true,
        },
        { name: "candidate_email", type: "email", description: "The applicant's email address.", required: true },
        { name: "position", type: "text", description: "The role applied for.", required: true, quote: true },
        { name: "years_of_experience", type: "number", description: "Years of relevant experience, if stated." },
        { name: "skills", type: "text_list", description: "Skills the applicant names." },
        { name: "has_attachment", type: "boolean", description: "Whether a CV or resume is attached." },
      ],
    },
  },
  {
    id: "insurance_claim",
    title: "Insurance claim",
    definition: {
      name: "insurance_claim",
      label: "Insurance claim",
      description: "A claim for an insured loss: policy number, incident date and what happened.",
      examples: ["Claim for water damage under policy HO-558812"],
      fields: [
        {
          name: "policy_number",
          type: "text",
          description: "The policy number as printed.",
          required: true,
          quote: true,
          comparator: "exact",
        },
        {
          name: "claimant_name",
          type: "text",
          description: "The person or company making the claim.",
          required: true,
          quote: true,
        },
        {
          name: "incident_date",
          type: "date",
          description: "When the loss happened, as YYYY-MM-DD.",
          required: true,
          quote: true,
        },
        {
          name: "claim_type",
          type: "enum",
          description: "The kind of loss.",
          enum: ["property", "vehicle", "health", "liability", "travel", "other"],
        },
        {
          name: "claimed_amount",
          type: "amount",
          description: "Amount claimed, if stated, as a plain number.",
          quote: true,
        },
        {
          name: "description",
          type: "long_text",
          description: "What happened, in one or two sentences.",
          required: true,
        },
      ],
    },
  },
  {
    id: "order_confirmation",
    title: "Order confirmation",
    definition: {
      name: "order_confirmation",
      label: "Order confirmation",
      description: "A seller confirming an order the recipient placed, before shipping or invoicing.",
      examples: ["Thanks for your order #A-20931", "Order confirmed: 3 items"],
      fields: [
        {
          name: "seller_name",
          type: "text",
          description: "Who the order was placed with.",
          required: true,
          quote: true,
        },
        {
          name: "order_number",
          type: "text",
          description: "The order number as printed.",
          required: true,
          quote: true,
          comparator: "exact",
        },
        { name: "order_date", type: "date", description: "Order date, as YYYY-MM-DD.", quote: true },
        currency,
        { name: "total", type: "amount", description: "Order total, as a plain number.", quote: true },
        lineItems,
      ],
    },
  },
];

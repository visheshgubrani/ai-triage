import { addDays, isoDate, money, type Rng, round2, writtenDate } from "./rng";

// Invented organizations and people (no real companies). Domains use the reserved .example TLD.

export const VENDORS = [
  {
    name: "Brightline Office Supply Ltd",
    domain: "brightline-office.example",
    prefix: "BOS",
    address: "14 Canal Street, Leeds LS1 4AB, United Kingdom",
    items: [
      "A4 copier paper (box of 5 reams)",
      "Ergonomic office chair",
      "Whiteboard markers (pack of 12)",
      "Desk organiser set",
    ],
  },
  {
    name: "Kestrel Logistics GmbH",
    domain: "kestrel-logistics.example",
    prefix: "KL",
    address: "Hafenstrasse 22, 20457 Hamburg, Germany",
    items: [
      "Pallet freight Hamburg to Rotterdam",
      "Warehouse storage (per pallet, monthly)",
      "Customs clearance fee",
      "Express courier surcharge",
    ],
  },
  {
    name: "Harbor & Pine Catering",
    domain: "harborpine.example",
    prefix: "HPC",
    address: "220 Water Street, Portland, ME 04101, USA",
    items: ["Lunch buffet (per person)", "Coffee and pastries service", "Event staff (per hour)", "Equipment rental"],
  },
  {
    name: "Quillmark Printing Co.",
    domain: "quillmark.example",
    prefix: "QP",
    address: "88 Market Lane, Bristol BS1 3QD, United Kingdom",
    items: [
      "Business cards (500)",
      "A1 posters, full colour",
      "Brochure printing (1,000 copies)",
      "Design proof revision",
    ],
  },
  {
    name: "Northgate Cloud Services Inc.",
    domain: "northgate-cloud.example",
    prefix: "NCS",
    address: "500 Mission Street, San Francisco, CA 94105, USA",
    items: [
      "Managed Kubernetes cluster (monthly)",
      "Object storage, 10 TB",
      "24/7 support plan",
      "Data egress overage",
    ],
  },
  {
    name: "Ironbark Industrial Parts Pty Ltd",
    domain: "ironbark-parts.example",
    prefix: "IIP",
    address: "9 Foundry Road, Geelong VIC 3220, Australia",
    items: [
      "Hydraulic pump seal kit",
      "Stainless steel fasteners (bulk)",
      "Conveyor belt section, 2 m",
      "Bearing assembly",
    ],
  },
  {
    name: "Copperleaf Facilities Management",
    domain: "copperleaf-fm.example",
    prefix: "CFM",
    address: "3 Riverside Way, Manchester M3 5FS, United Kingdom",
    items: ["Office cleaning (monthly)", "HVAC maintenance visit", "Window cleaning", "Waste collection"],
  },
  {
    name: "Meridian Lab Equipment",
    domain: "meridian-lab.example",
    prefix: "MLE",
    address: "41 Science Park, Cambridge CB4 0WS, United Kingdom",
    items: [
      "Centrifuge calibration service",
      "Pipette tips (case of 960)",
      "Benchtop pH meter",
      "Nitrile gloves (box of 100)",
    ],
  },
] as const;

export const CLIENTS = [
  { name: "Saltmarsh Coffee Roasters", address: "17 Quay Road, Whitby YO21 1DH, United Kingdom", contact: "Priya" },
  { name: "Orchard Lane IT Consulting", address: "62 Orchard Lane, Dublin D02 X285, Ireland", contact: "Tomas" },
  { name: "Tessellate Design Studio", address: "5 Atelier Court, Lisbon 1200-195, Portugal", contact: "Maya" },
  {
    name: "Bluefin Packaging Ltd",
    address: "Unit 4, Dock Estate, Southampton SO14 3TJ, United Kingdom",
    contact: "Jonah",
  },
  { name: "Lindqvist Robotics AB", address: "Kungsgatan 12, 111 43 Stockholm, Sweden", contact: "Elin" },
] as const;

const FIRST = [
  "Jane",
  "Omar",
  "Lucia",
  "Kenji",
  "Amara",
  "Felix",
  "Sofia",
  "Rahul",
  "Greta",
  "Mateo",
  "Nadia",
  "Theo",
  "Ines",
  "Kwame",
];
const LAST = [
  "Doe",
  "Haddad",
  "Romero",
  "Sato",
  "Okafor",
  "Brandt",
  "Rossi",
  "Mehta",
  "Nilsson",
  "Alvarez",
  "Petrova",
  "Walsh",
  "Costa",
  "Mensah",
];

export const PRODUCTS = [
  "Aero 2 electric kettle",
  "Strata standing desk",
  "Lumen desk lamp",
  "Nimbus air purifier",
  "Cadence wireless headphones",
  "Orbit robot vacuum",
  "Ledgerline accounting app",
  "Tempo fitness tracker",
];

export const LAWS = ["State of New York", "England and Wales", "State of Delaware", "Germany", "Province of Ontario"];
export const CURRENCIES = ["USD", "EUR", "GBP"] as const;

export function person(rng: Rng) {
  const first = rng.pick(FIRST);
  const last = rng.pick(LAST);
  return { name: `${first} ${last}`, email: `${first}.${last}@example.com`.toLowerCase() };
}

// ── Invoices ─────────────────────────────────────────────────────────────────────────────────

export interface InvoiceData {
  vendor: (typeof VENDORS)[number];
  client: (typeof CLIENTS)[number];
  number: string;
  issued: string;
  due: string;
  currency: string;
  items: { description: string; quantity: number; unit_price: number; amount: number }[];
  subtotal: number;
  tax: number;
  taxRate: number;
  total: number;
  po?: string;
}

export function invoiceData(rng: Rng): InvoiceData {
  const vendor = rng.pick(VENDORS);
  const issued = isoDate(rng);
  const items = Array.from({ length: rng.int(1, 4) }, (_, i) => {
    const quantity = rng.int(1, 12);
    const unit_price = round2(rng.int(1500, 90000) / 100);
    return {
      description: vendor.items[i % vendor.items.length] ?? "Service",
      quantity,
      unit_price,
      amount: round2(quantity * unit_price),
    };
  });
  const subtotal = round2(items.reduce((s, i) => s + i.amount, 0));
  const taxRate = rng.pick([0, 0.1, 0.2]);
  const tax = round2(subtotal * taxRate);
  return {
    vendor,
    client: rng.pick(CLIENTS),
    number: `${vendor.prefix}-${rng.int(1000, 9999)}`,
    issued,
    due: addDays(issued, rng.pick([14, 30, 45])),
    currency: rng.pick(CURRENCIES),
    items,
    subtotal,
    tax,
    taxRate,
    total: round2(subtotal + tax),
    po: rng.next() < 0.5 ? `PO-${rng.int(10000, 99999)}` : undefined,
  };
}

export function invoiceLines(d: InvoiceData, style: number, opts: { totalOverride?: number } = {}): string[] {
  const label = ["Invoice number", "Invoice No.", "Invoice #"][style % 3];
  return [
    `# ${d.vendor.name}`,
    d.vendor.address,
    `billing@${d.vendor.domain}`,
    "",
    "# INVOICE",
    `${label}: ${d.number}`,
    `Invoice date: ${writtenDate(d.issued, style)}`,
    `Due date: ${writtenDate(d.due, style)}`,
    ...(d.po ? [`PO number: ${d.po}`] : []),
    "",
    `Bill to: ${d.client.name}`,
    d.client.address,
    "",
    "Description | Qty | Unit price | Amount",
    ...d.items.map((i) => `${i.description} | ${i.quantity} | ${money(i.unit_price)} | ${money(i.amount)}`),
    "",
    `Subtotal: ${money(d.subtotal)} ${d.currency}`,
    `Tax (${Math.round(d.taxRate * 100)}%): ${money(d.tax)} ${d.currency}`,
    `Total due: ${money(opts.totalOverride ?? d.total)} ${d.currency}`,
    "",
    `Payment terms: bank transfer within ${Math.round((Date.parse(d.due) - Date.parse(d.issued)) / 86400000)} days, quoting ${d.number}.`,
  ];
}

export function invoiceFields(d: InvoiceData, opts: { totalOverride?: number } = {}) {
  return {
    vendor_name: d.vendor.name,
    invoice_number: d.number,
    invoice_date: d.issued,
    due_date: d.due,
    currency: d.currency,
    subtotal: d.subtotal,
    tax: d.tax,
    total: opts.totalOverride ?? d.total,
    ...(d.po ? { po_number: d.po } : {}),
    line_items: d.items,
  };
}

// ── Support requests ─────────────────────────────────────────────────────────────────────────

const ISSUES = [
  {
    severity: "medium",
    action: "replacement",
    text: (p: string, o: string) =>
      `My ${p} arrived with a cracked lid and it leaks when I fill it. The order number is ${o}. Could you send me a replacement?`,
    summary: (p: string) => `${p} arrived damaged and leaks`,
  },
  {
    severity: "high",
    action: "refund",
    text: (_p: string, o: string) =>
      `I was charged twice for order ${o} - both payments show on my card statement. Please refund the duplicate charge.`,
    summary: () => "Charged twice for one order",
  },
  {
    severity: "urgent",
    action: "account_change",
    text: (p: string) =>
      `I can't sign in to my ${p} account since this morning and the password reset email never arrives. I have a client presentation in two hours, please help urgently.`,
    summary: () => "Locked out of account, reset email not arriving",
  },
  {
    severity: "medium",
    action: "repair",
    text: (p: string, o: string) =>
      `The ${p} I bought (order ${o}) stopped turning on after two weeks. I believe it's still under warranty - can you repair it?`,
    summary: (p: string) => `${p} stopped working after two weeks`,
  },
  {
    severity: "low",
    action: "cancellation",
    text: (p: string) =>
      `Please cancel my ${p} subscription at the end of the current billing period. I no longer need it.`,
    summary: (p: string) => `Cancel ${p} subscription`,
  },
  {
    severity: "high",
    action: "other",
    text: (p: string) =>
      `Since yesterday's update, our whole team gets an error when exporting reports from ${p}. We can't close the month until this works again.`,
    summary: (p: string) => `Report export fails in ${p} after update`,
  },
  {
    severity: "low",
    action: "information",
    text: (p: string) => `Before I order: does the ${p} work with 110 V outlets, and does it come with a US plug?`,
    summary: (p: string) => `Asks whether ${p} supports 110 V`,
  },
] as const;

export function supportData(rng: Rng, index: number) {
  const issue = ISSUES[index % ISSUES.length] ?? ISSUES[0];
  const customer = person(rng);
  const product = rng.pick(PRODUCTS);
  const order = `${rng.pick(["ORD-", "SO-"])}${rng.int(100000, 999999)}`;
  const body = issue.text(product, order);
  return {
    customer,
    product,
    body,
    // Label only what the message states.
    fields: {
      customer_name: customer.name,
      customer_email: customer.email,
      ...(body.includes(product) ? { product } : {}),
      ...(body.includes(order) ? { order_id: order } : {}),
      issue_summary: issue.summary(product),
      severity: issue.severity,
      requested_action: issue.action,
    },
  };
}

// ── Contracts ────────────────────────────────────────────────────────────────────────────────

const CONTRACT_TYPES = [
  { type: "nda", title: "MUTUAL NON-DISCLOSURE AGREEMENT", roles: ["Party", "Party"], fees: false },
  { type: "msa", title: "MASTER SERVICES AGREEMENT", roles: ["Supplier", "Customer"], fees: true },
  { type: "sow", title: "STATEMENT OF WORK No. 3", roles: ["Supplier", "Customer"], fees: true },
  { type: "services", title: "CONSULTING SERVICES AGREEMENT", roles: ["Consultant", "Client"], fees: true },
  { type: "lease", title: "COMMERCIAL LEASE AGREEMENT", roles: ["Landlord", "Tenant"], fees: true },
] as const;

export function contractData(rng: Rng, index: number) {
  const kind = CONTRACT_TYPES[index % CONTRACT_TYPES.length] ?? CONTRACT_TYPES[0];
  const a = rng.pick(VENDORS);
  const b = rng.pick(CLIENTS);
  const effective = isoDate(rng, "2026-01-01", 300);
  const term = rng.pick([12, 24, 36]);
  const law = rng.pick(LAWS);
  const currency = rng.pick(CURRENCIES);
  const value = kind.fees ? rng.int(12, 240) * 1000 : undefined;
  const autoRenewal = rng.next() < 0.5;
  return {
    kind,
    parties: [
      { name: a.name, role: kind.roles[0] },
      { name: b.name, role: kind.roles[1] },
    ],
    effective,
    term,
    law,
    currency,
    value,
    autoRenewal,
    fields: {
      contract_type: kind.type,
      parties: [
        { name: a.name, role: kind.roles[0] },
        { name: b.name, role: kind.roles[1] },
      ],
      effective_date: effective,
      term_months: term,
      governing_law: law,
      ...(value ? { total_value: value, currency } : {}),
      auto_renewal: autoRenewal,
    },
  };
}

export function contractLines(
  c: ReturnType<typeof contractData>,
  style: number,
  opts: { draft?: boolean } = {},
): string[] {
  const [a, b] = c.parties as [{ name: string; role: string }, { name: string; role: string }];
  const effective = opts.draft ? "[__________]" : writtenDate(c.effective, style);
  return [
    ...(opts.draft ? ["DRAFT - FOR DISCUSSION ONLY - NOT FOR SIGNATURE", ""] : []),
    `# ${c.kind.title}`,
    "",
    `This ${c.kind.title.toLowerCase().replace(/ no\. \d+/, "")} (the "Agreement") is entered into as of ${effective} (the "Effective Date") by and between ${a.name} (the "${a.role}") and ${b.name} (the "${b.role}"), each a "Party".`,
    "",
    "1. Purpose. The Parties wish to work together on the matters described in this Agreement and any schedules to it.",
    c.kind.type === "nda"
      ? "2. Confidential Information. Each Party may disclose business, technical and financial information that the other Party must keep confidential and use only for the Purpose."
      : `2. Services. The ${a.role} will provide the services described in Schedule 1 to the ${b.role} with reasonable skill and care.`,
    `3. Term. This Agreement starts on the Effective Date and continues for an initial term of ${c.term} months.`,
    c.autoRenewal
      ? "4. Renewal. This Agreement renews automatically for successive 12-month periods unless either Party gives 60 days' written notice of non-renewal."
      : "4. Renewal. This Agreement does not renew automatically; any extension must be agreed in writing.",
    "---",
    c.value
      ? `5. Fees. The total fees payable under this Agreement shall not exceed ${money(c.value)} ${c.currency}, invoiced monthly in arrears.`
      : "5. No Fees. No fees are payable by either Party under this Agreement.",
    "6. Termination. Either Party may terminate this Agreement for material breach that remains uncured 30 days after written notice.",
    `7. Governing Law. This Agreement is governed by the laws of ${c.law}, and the courts there have exclusive jurisdiction.`,
    "8. Entire Agreement. This Agreement is the entire agreement between the Parties about its subject matter.",
    "",
    "Signed for and on behalf of each Party:",
    "",
    `${a.name} - Name: ____________ Title: ____________ Date: ____________`,
    `${b.name} - Name: ____________ Title: ____________ Date: ____________`,
  ];
}

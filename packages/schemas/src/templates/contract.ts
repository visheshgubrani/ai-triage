import { z } from "zod";
import type { CategoryTemplate } from "../types";
import { field, str } from "./field";

const party = z.object({
  name: field(z.string().min(1), "Legal name of the party."),
  role: field(z.string().min(1), "Role in the contract, such as customer, supplier, employer or landlord.").optional(),
});

export const contract: CategoryTemplate = {
  category: "contract",
  version: 1,
  schema: z
    .object({
      contract_type: field(
        z.enum(["nda", "msa", "sow", "services", "employment", "lease", "purchase", "other"]),
        "Kind of agreement.",
      ),
      parties: field(z.array(party).min(2), "Every party that signs the agreement."),
      effective_date: field(z.iso.date(), "Date the agreement takes effect, as YYYY-MM-DD.", { quote: true }),
      end_date: field(z.iso.date(), "Date the agreement ends, as YYYY-MM-DD, if stated.", { quote: true }).optional(),
      term_months: field(z.int().positive(), "Length of the initial term in months, if stated.", {
        quote: true,
      }).optional(),
      governing_law: field(z.string().min(1), "Jurisdiction whose law governs the agreement.", {
        quote: true,
      }).optional(),
      total_value: field(z.number(), "Total contract value, as a plain number, if stated.", { quote: true }).optional(),
      currency: field(z.string().regex(/^[A-Z]{3}$/), "ISO 4217 code of total_value.").optional(),
      auto_renewal: field(z.boolean(), "Whether the agreement renews automatically.").optional(),
    })
    .meta({ description: "A legal agreement between parties: NDAs, service agreements, statements of work, leases." }),
  comparators: {
    contract_type: "exact",
    parties: "set_f1",
    effective_date: "date",
    end_date: "date",
    term_months: "exact",
    governing_law: "normalized",
    total_value: "amount",
    currency: "exact",
    auto_renewal: "exact",
  },
  rules: [
    {
      id: "end_after_effective",
      description: "The end date is after the effective date.",
      check: (v) => {
        const [start, end] = [str(v.effective_date), str(v.end_date)];
        return start && end ? end > start : undefined;
      },
    },
  ],
};

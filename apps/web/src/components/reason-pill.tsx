import { describeReason } from "@ai-triage/core/review";
import { Pill, type Tone } from "@/components/badge";

/** Why a document is waiting, in words. Hovering shows what it means and the stored code. */
export function ReasonPill({ reason, tone }: { reason: string; tone?: Tone }) {
  const { label, help } = describeReason(reason);
  return (
    <Pill tone={tone} title={help ? `${help} (${reason})` : reason}>
      {label}
    </Pill>
  );
}

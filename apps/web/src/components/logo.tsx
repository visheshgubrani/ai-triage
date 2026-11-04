import { Inbox } from "lucide-react";

export function LogoMark({ className = "size-8" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground ${className}`}
    >
      <Inbox className="size-[60%]" />
    </span>
  );
}

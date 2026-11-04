import type { ComponentProps } from "react";
import { Button as UiButton } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

const VARIANTS = {
  primary: "default",
  secondary: "outline",
  danger: "destructive",
  ghost: "ghost",
  link: "link",
} as const;

/**
 * The app's button: shadcn's, with a keyboard hint. `shortcut` goes inside the button, so it is part
 * of the accessible name (`Approve a`); it can't combine with `asChild`, which needs a single child.
 */
export function Button({
  variant = "secondary",
  shortcut,
  className,
  children,
  asChild,
  ...props
}: Omit<ComponentProps<typeof UiButton>, "variant"> & { variant?: keyof typeof VARIANTS; shortcut?: string }) {
  if (asChild) {
    return (
      <UiButton asChild variant={VARIANTS[variant]} className={className} {...props}>
        {children}
      </UiButton>
    );
  }
  return (
    <UiButton type="button" variant={VARIANTS[variant]} className={cn(className)} {...props}>
      {children}
      {shortcut && (
        <Kbd
          className={cn(
            "ml-0.5 h-4 min-w-4 font-mono text-[10px]",
            variant === "primary" && "bg-primary-foreground/20 text-primary-foreground",
          )}
        >
          {shortcut}
        </Kbd>
      )}
    </UiButton>
  );
}

import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * Every table's look, in one place: write plain thead/tbody/tr/th/td inside. It bleeds to the edges
 * of the Section around it, so its rows run the full width of the card; `plain` (a table nested in
 * something else) stays inside its parent.
 */
export function DataTable({
  className,
  plain = false,
  children,
  ...props
}: ComponentProps<"table"> & { plain?: boolean }) {
  return (
    <div className={cn("overflow-x-auto", !plain && "-mx-4")}>
      <table
        {...props}
        className={cn(
          "w-full text-left text-sm [&_tbody_tr]:border-t [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-muted/50 [&_td]:px-2.5 [&_td]:py-2.5 [&_td]:align-top [&_th]:h-8 [&_th]:px-2.5 [&_th]:font-medium [&_th]:whitespace-nowrap [&_thead]:text-xs [&_thead]:text-muted-foreground",
          !plain && "[&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4",
          plain && "[&_td:first-child]:pl-0 [&_td:last-child]:pr-0 [&_th:first-child]:pl-0 [&_th:last-child]:pr-0",
          className,
        )}
      >
        {children}
      </table>
    </div>
  );
}

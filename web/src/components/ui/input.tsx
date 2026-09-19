import * as React from "react";
import { cn } from "@/lib/utils";

export function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      className={cn(
        "ease-spring flex h-9 w-full rounded-full border border-input bg-background/40 px-3.5 py-1 text-sm shadow-[inset_0_1px_2px_rgba(0,0,0,0.04)] backdrop-blur transition-[box-shadow,border-color] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

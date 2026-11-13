"use client";
import { useFormStatus } from "react-dom";
import type { ButtonHTMLAttributes } from "react";

export function SubmitButton({
  children,
  pendingLabel = "保存中…",
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { pendingLabel?: string }) {
  const { pending } = useFormStatus();
  return (
    <button {...props} type="submit" disabled={pending || disabled} aria-busy={pending}>
      {pending ? (
        <>
          <span className="spinner" aria-hidden="true" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}

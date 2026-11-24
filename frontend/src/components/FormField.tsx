import type { ReactNode } from "react";

interface FormFieldProps {
  id: string;
  label: string;
  children: ReactNode;
  error?: string;
  hint?: string;
  required?: boolean;
  className?: string;
}

export function FormField({ id, label, children, error, hint, required, className = "" }: FormFieldProps) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      <label htmlFor={id} className="block text-sm font-medium text-navy-900">
        {label}
        {required ? <span className="ml-0.5 text-rose-500" aria-hidden="true">*</span> : null}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs font-medium text-rose-600">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const inputClass =
  "block w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-navy-900 shadow-sm outline-none transition-all duration-200 ease-smooth placeholder:text-slate-400 hover:border-slate-300 focus:border-accent-600 focus:ring-2 focus:ring-accent-100 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500";

export function inputWithError(hasError?: boolean): string {
  return hasError ? `${inputClass} border-rose-300 focus:border-rose-500 focus:ring-rose-100` : inputClass;
}

interface FieldErrorProps {
  id: string;
  error?: string;
}

export function FieldError({ id, error }: FieldErrorProps) {
  if (!error) return null;
  return (
    <p id={`${id}-error`} role="alert" className="text-xs font-medium text-rose-600">
      {error}
    </p>
  );
}

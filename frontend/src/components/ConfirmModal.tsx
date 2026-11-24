"use client";

import { useId } from "react";
import { AlertTriangle } from "lucide-react";
import { Modal } from "./Modal";

interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  loading?: boolean;
}

export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "primary",
  loading = false,
}: ConfirmModalProps) {
  const descriptionId = useId();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      describedBy={descriptionId}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-600 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={loading}
            className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50 ${
              tone === "danger"
                ? "bg-rose-600 hover:bg-rose-700 focus-visible:ring-rose-500"
                : "bg-accent-600 hover:bg-accent-700 focus-visible:ring-accent-600"
            }`}
          >
            {loading ? "Working…" : confirmLabel}
          </button>
        </div>
      }
    >
      <div className="flex gap-3">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
            tone === "danger" ? "bg-rose-50 text-rose-600" : "bg-accent-50 text-accent-600"
          }`}
          aria-hidden="true"
        >
          <AlertTriangle className="h-5 w-5" />
        </span>
        <p id={descriptionId} className="pt-1 text-sm leading-relaxed text-slate-600">
          {message}
        </p>
      </div>
    </Modal>
  );
}

"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { ShieldCheck } from "lucide-react";
import { FormField, inputWithError } from "@/components/FormField";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/ToastProvider";
import { api, getErrorMessage } from "@/lib/api";
import { isValidAssetCode, parseJsonObject } from "@/lib/validators";
import type { Agreement } from "@/lib/types";

function jsonText(value: unknown): string {
  return value && typeof value === "object" ? JSON.stringify(value, null, 2) : "";
}

const schema = z.object({
  title: z.string().trim().min(3, "Give the agreement a title."),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  asset_code: z.string().trim().refine(isValidAssetCode, "Use 1–12 letters or digits."),
  asset_issuer: z.string().trim().optional().or(z.literal("")),
  expiry_date: z.string().min(1, "Choose an expiry date."),
  conditions: z.string().trim().superRefine((value, context) => {
    if (!value) return;
    try {
      parseJsonObject(value);
    } catch (error) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : "Enter a valid JSON object." });
    }
  }),
  approval_requirements: z.string().trim().superRefine((value, context) => {
    if (!value) return;
    try {
      parseJsonObject(value);
    } catch (error) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : "Enter a valid JSON object." });
    }
  }),
}).superRefine((values, context) => {
  if (values.asset_code.trim().toUpperCase() !== "XLM" && !values.asset_issuer?.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["asset_issuer"], message: "Asset issuer is required for non-XLM assets." });
  }
});

type FormValues = z.infer<typeof schema>;

function dateValue(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

interface EditAgreementModalProps {
  agreement: Agreement;
  onClose: () => void;
  onSaved: (agreement: Agreement) => void;
}

/** Edits only the draft fields the backend accepts through PATCH. */
export function EditAgreementModal({ agreement, onClose, onSaved }: EditAgreementModalProps) {
  const toast = useToast();
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: agreement.title,
      description: agreement.description || "",
      asset_code: agreement.asset_code || "XLM",
      asset_issuer: agreement.asset_issuer || "",
      expiry_date: dateValue(agreement.expiry_date),
      conditions: jsonText(agreement.conditions),
      approval_requirements: jsonText(agreement.approval_requirements),
    },
  });

  const onSubmit = async (values: FormValues) => {
    try {
      const conditions = parseJsonObject(values.conditions || "");
      const approvalRequirements = parseJsonObject(values.approval_requirements || "");
      const updated = await api.patch<Agreement>(`/agreements/${agreement.id}`, {
        title: values.title,
        ...(values.description?.trim() ? { description: values.description.trim() } : {}),
        asset_code: values.asset_code.toUpperCase(),
        ...(values.asset_issuer?.trim() ? { asset_issuer: values.asset_issuer.trim() } : {}),
        expiry_date: new Date(values.expiry_date).toISOString(),
        ...(conditions ? { conditions } : {}),
        ...(approvalRequirements ? { approval_requirements: approvalRequirements } : {}),
      });
      onSaved(updated);
      toast.success("Agreement updated");
    } catch (reason) {
      toast.error("Could not save changes", getErrorMessage(reason));
    }
  };

  return (
    <Modal open onClose={onClose} title="Edit agreement" description="Only draft agreements can be changed. Milestones stay unchanged." size="md">
      <form onSubmit={handleSubmit((values) => void onSubmit(values))} className="space-y-5" noValidate>
        <div className="flex items-start gap-2.5 rounded-control border border-accent-100 bg-accent-50 px-3 py-2.5 text-xs leading-relaxed text-accent-700">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>Values below are saved with a PATCH request. Financial state, funding and on-chain events cannot be edited here.</p>
        </div>
        <FormField id="edit-ag-title" label="Title" error={errors.title?.message} required>
          <input id="edit-ag-title" className={inputWithError(!!errors.title)} {...register("title")} />
        </FormField>
        <FormField id="edit-ag-description" label="Description" error={errors.description?.message}>
          <textarea id="edit-ag-description" rows={2} className={inputWithError(!!errors.description)} {...register("description")} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField id="edit-ag-asset" label="Asset" error={errors.asset_code?.message} required>
            <input id="edit-ag-asset" maxLength={12} className={`${inputWithError(!!errors.asset_code)} uppercase`} {...register("asset_code")} />
          </FormField>
          <FormField id="edit-ag-expiry" label="Expiry date" error={errors.expiry_date?.message} required>
            <input id="edit-ag-expiry" type="date" className={inputWithError(!!errors.expiry_date)} {...register("expiry_date")} />
          </FormField>
        </div>
        <FormField id="edit-ag-issuer" label="Asset issuer" error={errors.asset_issuer?.message} hint="Leave blank for native XLM">
          <input id="edit-ag-issuer" placeholder="G…" className={inputWithError(!!errors.asset_issuer)} {...register("asset_issuer")} />
        </FormField>
        <FormField id="edit-ag-conditions" label="Conditions (JSON)" error={errors.conditions?.message} hint='For example: {"delivery": "on receipt"}'>
          <textarea id="edit-ag-conditions" rows={3} className={`${inputWithError(!!errors.conditions)} font-mono text-xs`} {...register("conditions")} />
        </FormField>
        <FormField id="edit-ag-approval" label="Approval requirements (JSON)" error={errors.approval_requirements?.message} hint='For example: {"approver": "finance"}'>
          <textarea id="edit-ag-approval" rows={3} className={`${inputWithError(!!errors.approval_requirements)} font-mono text-xs`} {...register("approval_requirements")} />
        </FormField>
        <div className="flex flex-col-reverse justify-end gap-2 border-t border-line pt-4 sm:flex-row">
          <button type="button" onClick={onClose} className="ui-btn-secondary">Cancel</button>
          <button type="submit" disabled={isSubmitting} className="ui-btn-accent">
            {isSubmitting ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

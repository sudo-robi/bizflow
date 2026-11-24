"use client";

import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Loader2, Mail, Plus, Shield, Trash2, Users } from "lucide-react";
import { ConfirmModal } from "@/components/ConfirmModal";
import { EmptyState } from "@/components/EmptyState";
import { FormField, inputWithError } from "@/components/FormField";
import { PageHeader, SectionCard } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/components/ToastProvider";
import { useAuth } from "@/app/providers";
import { api, getErrorMessage } from "@/lib/api";
import { initials } from "@/lib/format";
import { useApiResource } from "@/lib/useApiResource";
import type { Business, Member, Role } from "@/lib/types";

const businessSchema = z.object({
  name: z.string().trim().min(2, "Enter a business name."),
  legal_name: z.string().trim().max(160).optional().or(z.literal("")),
  country: z.string().trim().max(80).optional().or(z.literal("")),
  currency: z.string().trim().length(3, "Use a 3-letter currency code.").transform((value) => value.toUpperCase()),
});
type BusinessValues = z.infer<typeof businessSchema>;

const inviteSchema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  role: z.enum(["admin", "finance_manager", "supplier"]),
});
type InviteValues = z.infer<typeof inviteSchema>;

const ROLE_OPTIONS: Array<{ value: Role; label: string }> = [
  { value: "owner", label: "Owner" },
  { value: "admin", label: "Admin" },
  { value: "finance_manager", label: "Finance manager" },
  { value: "supplier", label: "Supplier" },
];

export default function SettingsPage() {
  const toast = useToast();
  const { activeBusinessId, activeBusiness, can, refresh } = useAuth();
  const [savingBusiness, setSavingBusiness] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [busyMember, setBusyMember] = useState<string | null>(null);
  const [toRemove, setToRemove] = useState<Member | null>(null);

  const { data: members, loading: membersLoading, reload: reloadMembers } = useApiResource<Member[]>(
    () => api.get(`/businesses/${activeBusinessId}/members`),
    [activeBusinessId],
    !!activeBusinessId,
  );
  const canManage = can("owner", "admin");

  const businessForm = useForm<BusinessValues>({
    resolver: zodResolver(businessSchema),
    values: {
      name: activeBusiness?.name || "",
      legal_name: activeBusiness?.legal_name || "",
      country: activeBusiness?.country || "",
      currency: activeBusiness?.currency || "USD",
    },
  });

  const inviteForm = useForm<InviteValues>({ resolver: zodResolver(inviteSchema), defaultValues: { email: "", role: "finance_manager" } });

  const onSaveBusiness = async (values: BusinessValues) => {
    if (!activeBusinessId) return;
    setSavingBusiness(true);
    try {
      await api.patch(`/businesses/${activeBusinessId}`, values);
      await refresh();
      toast.success("Business profile updated");
    } catch (reason) {
      toast.error("Could not save business profile", getErrorMessage(reason));
    } finally {
      setSavingBusiness(false);
    }
  };

  const onInvite = async (values: InviteValues) => {
    if (!activeBusinessId) return;
    setInviting(true);
    try {
      await api.post(`/businesses/${activeBusinessId}/members`, values);
      inviteForm.reset({ email: "", role: "finance_manager" });
      reloadMembers();
      toast.success("Invitation sent", values.role === "supplier" ? "Supplier access granted for that account." : "Team member added or invited.");
    } catch (reason) {
      toast.error("Could not invite member", getErrorMessage(reason));
    } finally {
      setInviting(false);
    }
  };

  const changeRole = async (member: Member, role: Role) => {
    if (!activeBusinessId || !member.user?.id) return;
    setBusyMember(member.user.id);
    try {
      await api.patch(`/businesses/${activeBusinessId}/members/${member.user.id}`, { role });
      reloadMembers();
      toast.success("Role updated");
    } catch (reason) {
      toast.error("Could not update role", getErrorMessage(reason));
    } finally {
      setBusyMember(null);
    }
  };

  const removeMember = async () => {
    if (!activeBusinessId || !toRemove?.user?.id) return;
    setBusyMember(toRemove.user.id);
    try {
      await api.delete(`/businesses/${activeBusinessId}/members/${toRemove.user.id}`);
      setToRemove(null);
      reloadMembers();
      toast.success("Member removed");
    } catch (reason) {
      toast.error("Could not remove member", getErrorMessage(reason));
    } finally {
      setBusyMember(null);
    }
  };

  return (
    <div className="animate-fade-in">
      <PageHeader eyebrow="Workspace" title="Settings" description="Manage your business profile and the people who can access this workspace." />

      <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
        <SectionCard title="Business profile" description="Shown on invoices and agreements">
          <form onSubmit={businessForm.handleSubmit((values) => void onSaveBusiness(values))} className="space-y-4" noValidate>
            <FormField id="set-name" label="Business name" error={businessForm.formState.errors.name?.message} required>
              <input id="set-name" className={inputWithError(!!businessForm.formState.errors.name)} {...businessForm.register("name")} disabled={!canManage} />
            </FormField>
            <FormField id="set-legal" label="Legal name" error={businessForm.formState.errors.legal_name?.message}>
              <input id="set-legal" className={inputWithError(!!businessForm.formState.errors.legal_name)} {...businessForm.register("legal_name")} disabled={!canManage} />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField id="set-country" label="Country" error={businessForm.formState.errors.country?.message}>
                <input id="set-country" className={inputWithError(!!businessForm.formState.errors.country)} {...businessForm.register("country")} disabled={!canManage} />
              </FormField>
              <FormField id="set-currency" label="Reporting currency" error={businessForm.formState.errors.currency?.message}>
                <input id="set-currency" maxLength={3} className={`${inputWithError(!!businessForm.formState.errors.currency)} uppercase`} {...businessForm.register("currency")} disabled={!canManage} />
              </FormField>
            </div>
            {canManage ? (
              <button type="submit" disabled={savingBusiness} className="inline-flex items-center gap-2 rounded-lg bg-accent-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-700 disabled:opacity-50">
                {savingBusiness ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {savingBusiness ? "Saving…" : "Save changes"}
              </button>
            ) : (
              <p className="text-xs text-slate-500">Only owners and admins can edit the business profile.</p>
            )}
          </form>
        </SectionCard>

        <div className="space-y-5">
          {canManage ? (
            <SectionCard title="Invite a team member" description="Unknown emails receive a pending invitation.">
              <form onSubmit={inviteForm.handleSubmit((values) => void onInvite(values))} className="space-y-4" noValidate>
                <FormField id="invite-email" label="Email address" error={inviteForm.formState.errors.email?.message} required>
                  <input id="invite-email" type="email" className={inputWithError(!!inviteForm.formState.errors.email)} placeholder="teammate@company.com" {...inviteForm.register("email")} />
                </FormField>
                <FormField id="invite-role" label="Role" error={inviteForm.formState.errors.role?.message} required>
                  <select id="invite-role" className={inputWithError(!!inviteForm.formState.errors.role)} {...inviteForm.register("role")}>
                    <option value="finance_manager">Finance manager</option>
                    <option value="admin">Admin</option>
                    <option value="supplier">Supplier</option>
                  </select>
                </FormField>
                <button type="submit" disabled={inviting} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-navy-900 hover:bg-slate-50 disabled:opacity-50">
                  {inviting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  {inviting ? "Sending…" : "Send invitation"}
                </button>
              </form>
            </SectionCard>
          ) : null}

          <div className="rounded-xl border border-accent-100 bg-accent-50 p-5">
            <Shield className="h-5 w-5 text-accent-600" />
            <p className="mt-3 text-sm font-semibold text-navy-900">Role-based access</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              Owners and admins manage everything. Finance managers create invoices and prepare payments. Suppliers can accept agreements and view their own records.
            </p>
          </div>
        </div>
      </div>

      <div className="mt-5">
        <SectionCard title="Team members" description={`${members?.length || 0} people with access to ${activeBusiness?.name || "this business"}`} className="[&>div:last-child]:p-0">
          {membersLoading ? (
            <div className="space-y-3 p-5">{[1, 2, 3].map((key) => <div key={key} className="h-14 animate-pulse rounded-lg bg-slate-50" />)}</div>
          ) : members?.length ? (
            <ul className="divide-y divide-slate-100">
              {members.map((member) => {
                const userId = member.user?.id;
                return (
                  <li key={userId || member.user?.email} className="flex flex-wrap items-center gap-4 px-5 py-4">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-navy-900 text-xs font-bold text-white">
                      {initials(member.user?.full_name || member.user?.email || "U")}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-navy-900">{member.user?.full_name || member.user?.email || "Team member"}</p>
                      <p className="flex items-center gap-1.5 truncate text-xs text-slate-500"><Mail className="h-3 w-3" /> {member.user?.email || "—"}</p>
                    </div>
                    <StatusBadge status={member.status || "active"} />
                    <select
                      value={member.role}
                      disabled={!canManage || member.role === "owner" || busyMember === userId}
                      onChange={(event) => void changeRole(member, event.target.value as Role)}
                      aria-label={`Role for ${member.user?.email || "member"}`}
                      className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-navy-900 outline-none focus:border-accent-600 disabled:bg-slate-50 disabled:text-slate-400"
                    >
                      {ROLE_OPTIONS.filter((option) => option.value !== "owner" || member.role === "owner").map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                    {canManage && member.role !== "owner" ? (
                      <button onClick={() => setToRemove(member)} className="rounded-lg p-2 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600" aria-label={`Remove ${member.user?.email || "member"}`}>
                        <Trash2 className="h-4 w-4" />
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState icon={<Users className="h-6 w-6" />} title="No team members" description="Invite teammates to collaborate on payments and approvals." />
          )}
        </SectionCard>
      </div>

      <ConfirmModal
        open={!!toRemove}
        onClose={() => setToRemove(null)}
        onConfirm={removeMember}
        title="Remove team member?"
        message={`${toRemove?.user?.email || "This member"} will lose access to this workspace immediately.`}
        confirmLabel="Remove member"
        tone="danger"
        loading={!!busyMember}
      />
    </div>
  );
}

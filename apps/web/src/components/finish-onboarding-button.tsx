"use client";
import { useRouter } from "next/navigation";
import { apiFetch } from "./api-client";

export function FinishOnboardingButton({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={async () => {
        await apiFetch("/me/preferences", { method: "PATCH", body: { onboardingCompleted: true } });
        router.push("/dashboard");
        router.refresh();
      }}
    >
      Go to dashboard
    </button>
  );
}

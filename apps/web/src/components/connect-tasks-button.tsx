"use client";
import { ConnectButton } from "./connect-button";

export function ConnectTasksButton(props: {
  mock: boolean;
  returnTo?: "/onboarding" | "/settings";
  label?: string;
}) {
  return (
    <ConnectButton
      endpoint="/integrations/google/connect"
      allowedRedirectOrigin="https://accounts.google.com"
      returnTo={props.returnTo ?? "/onboarding"}
      label={
        props.label ??
        (props.mock
          ? "Connect mock Google Tasks (synthetic data)"
          : "Connect Google Tasks (read-only)")
      }
      syncedMessage="Task lists found. Choose which to import."
    />
  );
}

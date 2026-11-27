"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useEffect, useState } from "react";

type Mailbox = {
  email: string;
  region: string;
  status: "legacy" | "connected" | "reconnect";
  lastScanAt: string | null;
};

type Connections = {
  enabled: boolean;
  adminConfigured: boolean;
  authenticated: boolean;
  accounts: Mailbox[];
};

const panelClass = "rounded-xl border border-[#E2D1AD] bg-[#FFF9ED] p-5 shadow-sm";
const inputClass = "w-full rounded-lg border border-[#E2D1AD] bg-white px-3 py-2 text-sm focus:border-[#1387C0] focus:outline-none focus:ring-2 focus:ring-[#1387C0]/15";
const primaryButtonClass = "rounded-lg bg-[#1387C0] px-4 py-2 text-sm font-semibold text-white hover:bg-[#0F6F9F] disabled:cursor-not-allowed disabled:opacity-60";
const secondaryButtonClass = "rounded-lg border border-[#1387C0]/25 bg-white px-4 py-2 text-sm font-medium text-[#0F6F9F] hover:bg-[#E9F6FC] disabled:cursor-not-allowed disabled:opacity-60";
const errorClass = "rounded-lg border border-[#F4520D]/30 bg-[#FFF1EB] px-4 py-3 text-sm text-[#A63B0A]";

const mailboxStates = {
  legacy: {
    label: "Using IMAP",
    style: "bg-[#FAEDD1] text-[#794E28]",
    action: "Connect with Google",
  },
  connected: {
    label: "Monitoring",
    style: "bg-emerald-50 text-emerald-800",
    action: "Reconnect",
  },
  reconnect: {
    label: "Needs reconnection",
    style: "bg-[#FFF1EB] text-[#A63B0A]",
    action: "Reconnect",
  },
} satisfies Record<Mailbox["status"], { label: string; style: string; action: string }>;

async function loadConnections(signal?: AbortSignal): Promise<Connections> {
  const response = await fetch("/api/gmail-connections", { cache: "no-store", signal });
  if (!response.ok) throw new Error("Could not load mailbox connections.");
  return response.json();
}

function ConnectionResult() {
  const result = useSearchParams().get("result");
  if (result === "connected") {
    return (
      <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
        Gmail connected. This inbox will be included in scheduled scans.
      </p>
    );
  }

  let message;
  switch (result) {
    case "denied":
      message = "Google authorization was declined. Try again to grant Gmail access.";
      break;
    case "invalid":
      message = "This connection request expired. Start a new connection from this page.";
      break;
    case "wrong_account":
      message = "The selected Google account belongs to a different mailbox. Try again and select the exact email address you entered.";
      break;
    case "failed":
      message = "The Gmail connection could not be verified. Try again.";
      break;
    default:
      return null;
  }

  return <p role="alert" className={errorClass}>{message}</p>;
}

export default function GmailConnectionsPage() {
  const [connections, setConnections] = useState<Connections | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [region, setRegion] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void loadConnections(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setConnections(data);
      },
      () => {
        if (!controller.signal.aborted) setLoadError(true);
      },
    );
    return () => controller.abort();
  }, [reload]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActionError(null);
    setPending("login");
    try {
      const response = await fetch("/api/gmail-connections/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) {
        throw new Error(result?.error || "Unable to sign in to the monitoring console.");
      }
      setPassword("");
      const data = await loadConnections();
      setConnections(data);
      if (!data.authenticated) {
        setActionError("Sign-in could not be confirmed. Check that this browser allows site cookies.");
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to sign in.");
    } finally {
      setPending(null);
    }
  }

  async function connect(email: string, region: string, action: string) {
    setActionError(null);
    setPending(action);
    try {
      const response = await fetch("/api/gmail-connections/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), region: region.trim() }),
      });
      if (response.status === 401 && connections) {
        setConnections({ ...connections, authenticated: false, accounts: [] });
        throw new Error("Your monitoring console session expired. Sign in and try again.");
      }
      const result = await response.json().catch(() => null);
      if (!response.ok || typeof result?.url !== "string") {
        throw new Error(result?.error || "Unable to start Google authorization.");
      }
      const authorizationUrl = new URL(result.url);
      if (authorizationUrl.origin !== "https://accounts.google.com") {
        throw new Error("Unable to verify the Google authorization page.");
      }
      window.location.assign(authorizationUrl.href);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Unable to start Google authorization.");
      setPending(null);
    }
  }

  function refreshConnections() {
    setLoadError(false);
    setReload((value) => value + 1);
  }

  const needsLogin = connections?.adminConfigured && !connections.authenticated;
  const canManage = connections?.enabled && connections.authenticated;

  return (
    <div className="min-h-screen bg-[#FAEDD1] text-[#1F2A33]">
      <header className="border-b border-[#E2D1AD] bg-[#FFF9ED] shadow-sm">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <h1 className="text-xl font-semibold tracking-tight text-[#0F6F9F]">Gmail accounts</h1>
          <Link href="/" className={secondaryButtonClass}>Back to dashboard</Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-6">
        <Suspense fallback={null}><ConnectionResult /></Suspense>
        {actionError ? <p role="alert" className={errorClass}>{actionError}</p> : null}

        {loadError ? (
          <section className={panelClass}>
            <p role="alert" className="mb-3 text-sm text-[#A63B0A]">Could not load mailbox connections.</p>
            <button type="button" className={secondaryButtonClass} onClick={refreshConnections}>Try again</button>
          </section>
        ) : !connections ? (
          <p role="status" className={panelClass}>Loading Gmail accounts…</p>
        ) : needsLogin ? (
          <section className={panelClass}>
            <h2 className="font-semibold text-[#0F6F9F]">Sign in to the monitoring console</h2>
            <p className="mt-1 text-sm text-[#3E4E59]">Use the console admin password. Enter Gmail credentials only on Google’s sign-in page.</p>
            <form onSubmit={login} className="mt-4 flex max-w-md flex-col gap-3 sm:flex-row sm:items-end">
              <label className="flex flex-1 flex-col gap-1 text-sm font-medium">
                Console admin password
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.currentTarget.value)}
                  className={inputClass}
                />
              </label>
              <button type="submit" disabled={pending !== null} className={primaryButtonClass}>
                {pending === "login" ? "Signing in…" : "Sign in"}
              </button>
            </form>
          </section>
        ) : !canManage ? (
          <p className={panelClass}>Gmail authorization is not configured for this deployment. Ask your administrator to complete the setup.</p>
        ) : (
          <>
            <section className={panelClass}>
              <h2 className="font-semibold text-[#0F6F9F]">Add an email account</h2>
              <p className="mt-1 text-sm text-[#3E4E59]">Authorize a Gmail or Google Workspace address to include it in all scheduled scans.</p>
              <form onSubmit={(event) => {
                event.preventDefault();
                void connect(email, region, "add");
              }} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
                <label className="flex flex-1 flex-col gap-1 text-sm font-medium">
                  Email address
                  <input
                    type="email"
                    autoComplete="email"
                    required
                    maxLength={254}
                    value={email}
                    onChange={(event) => setEmail(event.currentTarget.value)}
                    placeholder="dispatch@example.com"
                    className={inputClass}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium sm:w-32">
                  Region
                  <input
                    type="text"
                    required
                    maxLength={32}
                    value={region}
                    onChange={(event) => setRegion(event.currentTarget.value)}
                    placeholder="OAK"
                    className={inputClass}
                  />
                </label>
                <button type="submit" disabled={pending !== null} className={primaryButtonClass}>
                  {pending === "add" ? "Opening Google…" : "Continue to Google"}
                </button>
              </form>
            </section>

            <section className={panelClass}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold text-[#0F6F9F]">Monitored mailboxes</h2>
                <button
                  type="button"
                  className={secondaryButtonClass}
                  disabled={pending !== null}
                  onClick={refreshConnections}
                >
                  Refresh statuses
                </button>
              </div>
              {connections.accounts.length === 0 ? (
                <p className="mt-3 text-sm text-[#3E4E59]">Add a Gmail account to start monitoring.</p>
              ) : (
                <ul className="mt-2 divide-y divide-[#EEDFC3]">
                  {connections.accounts.map((account) => {
                    const status = mailboxStates[account.status];
                    return (
                      <li key={account.email} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <p className="break-all font-medium">{account.email}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#3E4E59]">
                            <span>{account.region}</span>
                            <span className={`rounded px-2 py-0.5 font-medium ${status.style}`}>{status.label}</span>
                            {account.lastScanAt ? (
                              <time dateTime={account.lastScanAt}>Last scan {new Date(account.lastScanAt).toLocaleString()}</time>
                            ) : account.status === "connected" ? (
                              <span>Awaiting first scan</span>
                            ) : null}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={pending !== null}
                          onClick={() => void connect(account.email, account.region, account.email)}
                          aria-label={`${status.action} ${account.email}`}
                          className={`self-start whitespace-nowrap sm:self-auto ${secondaryButtonClass}`}
                        >
                          {pending === account.email ? "Opening Google…" : status.action}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

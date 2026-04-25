"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Row = {
  id: string;
  emailAccount: string;
  region: string;
  warehouse: string;
  appointmentId: string;
  appointmentTimeText: string;
  subject: string;
  fromEmail: string;
  receivedAt: string;
  gmailMessageId: string;
  createdAt: string;
};

type AccountScanResult = {
  email: string;
  ok: boolean;
  inserted: number;
  skipped: number;
  error?: string;
  dbError?: string;
  note?: string;
  stats?: {
    searchUids: number;
    fetchedHeaders: number;
    afterLookbackAndRegex: number;
    mailbox?: string;
    dbFailures?: number;
    subjectMissAfterBodyFetch?: number;
    secondPullExpected?: number;
    secondPullReturned?: number;
  };
};

type ScanResponse = {
  success: boolean;
  scannedAccounts: number;
  inserted: number;
  skipped: number;
  accounts?: AccountScanResult[];
  error?: string;
};

const ALERTS_READ_KEY = "gmail-monitor-alerts-read-ids";
const RECENT_ALERT_LIMIT = 20;

const DEFAULT_ACCOUNTS = [
  "wgustruckingllc@gmail.com",
  "kindaglobalinc@gmail.com",
  "alreadyarrivedlogistics@gmail.com",
  "info.ygtruckingllc@gmail.com",
];

/** Stable palette per warehouse code for left bar + badge. */
const WAREHOUSE_PALETTE = [
  { bar: "border-l-[#1387C0]", badge: "bg-[#E9F6FC] text-[#0F6F9F] ring-1 ring-[#1387C0]/25" },
  { bar: "border-l-[#F4520D]", badge: "bg-[#FFF1EB] text-[#C6400A] ring-1 ring-[#F4520D]/30" },
  { bar: "border-l-[#1387C0]", badge: "bg-[#FAEDD1] text-[#8A5B2A] ring-1 ring-[#E2D1AD]" },
  { bar: "border-l-[#F4520D]", badge: "bg-[#FAEDD1] text-[#A36322] ring-1 ring-[#E2D1AD]" },
];

function hashKey(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(31, h) + s.charCodeAt(i) || 0;
  }
  return Math.abs(h);
}

function warehouseStyle(code: string) {
  return WAREHOUSE_PALETTE[hashKey(code) % WAREHOUSE_PALETTE.length];
}

function regionChipClass(region: string) {
  const r = region.toUpperCase();
  if (r === "SAV") return "bg-[#FAEDD1] text-[#8A5B2A] ring-1 ring-[#E2D1AD]";
  if (r === "OAK") return "bg-[#E9F6FC] text-[#0F6F9F] ring-1 ring-[#1387C0]/30";
  return "bg-[#F2F8FB] text-[#25698A] ring-1 ring-[#1387C0]/20";
}

/** Match Gmail-style English date/time for the Received column (appointment line stays as in email). */
function formatDateTime(iso: string) {
  try {
    return new Date(iso).toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function shortEmailLabel(email: string) {
  const [user, domain] = email.split("@");
  if (!domain) return email;
  const shortDom = domain.length > 12 ? `${domain.slice(0, 10)}…` : domain;
  return `${user}@${shortDom}`;
}

function toMs(iso: string) {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function loadReadAlertIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(ALERTS_READ_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string" && v.length > 0));
  } catch {
    return new Set();
  }
}

const shellClass =
  "w-full max-w-none px-4 sm:px-6 lg:px-10 xl:px-14 2xl:px-20";

export default function Home() {
  const [rows, setRows] = useState<Row[]>([]);
  const [readAlertIds, setReadAlertIds] = useState<Set<string>>(() => loadReadAlertIds());
  const [alertsVisibleCount, setAlertsVisibleCount] = useState(RECENT_ALERT_LIMIT);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [lastScanAccounts, setLastScanAccounts] = useState<AccountScanResult[] | null>(null);

  const [region, setRegion] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [emailAccount, setEmailAccount] = useState("");
  const [appointmentId, setAppointmentId] = useState("");

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (region) p.set("region", region);
    if (warehouse) p.set("warehouse", warehouse);
    if (emailAccount) p.set("emailAccount", emailAccount);
    if (appointmentId) p.set("appointmentId", appointmentId);
    const s = p.toString();
    return s ? `?${s}` : "";
  }, [region, warehouse, emailAccount, appointmentId]);

  const allAlerts = useMemo(() => {
    const sorted = [...rows].sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));
    return sorted;
  }, [rows]);

  const recentAlerts = useMemo(
    () => allAlerts.slice(0, alertsVisibleCount),
    [allAlerts, alertsVisibleCount],
  );

  const unreadAlertsCount = useMemo(
    () => allAlerts.filter((r) => !readAlertIds.has(r.id)).length,
    [allAlerts, readAlertIds],
  );

  /**
   * @param queryOverride - when `""`, fetch all rows (no filters). When `undefined`, use current filter state.
   */
  const loadRows = useCallback(
    async (queryOverride?: string) => {
      const suffix = queryOverride !== undefined ? queryOverride : queryString;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/reschedule-emails${suffix}`, { cache: "no-store" });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Request failed (${res.status})`);
        }
        const json = await res.json();
        setRows(json.data ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load data");
      } finally {
        setLoading(false);
      }
    },
    [queryString],
  );

  useEffect(() => {
    const t = setTimeout(() => {
      void loadRows();
    }, 0);
    return () => clearTimeout(t);
  }, [loadRows]);

  useEffect(() => {
    const timer = setInterval(() => {
      void loadRows();
    }, 60_000);
    return () => clearInterval(timer);
  }, [loadRows]);

  const markAlertRead = useCallback((id: string) => {
    setReadAlertIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      try {
        localStorage.setItem(ALERTS_READ_KEY, JSON.stringify(Array.from(next)));
      } catch {
        /* ignore storage error */
      }
      return next;
    });
  }, []);

  const markAlertsRead = useCallback(() => {
    const allIds = recentAlerts.map((r) => r.id);
    const next = new Set(readAlertIds);
    allIds.forEach((id) => next.add(id));
    setReadAlertIds(next);
    try {
      localStorage.setItem(ALERTS_READ_KEY, JSON.stringify(Array.from(next)));
    } catch {
      /* ignore storage error */
    }
  }, [readAlertIds, recentAlerts]);

  const loadMoreAlerts = useCallback(() => {
    setAlertsVisibleCount((n) => n + RECENT_ALERT_LIMIT);
  }, []);

  async function handleScan() {
    setScanning(true);
    setError(null);
    setScanMessage(null);
    setLastScanAccounts(null);
    try {
      const res = await fetch("/api/scan-gmail", { method: "POST", cache: "no-store" });
      const json: ScanResponse = await res.json();
      if (!res.ok) {
        throw new Error(json.error ?? `Scan failed (${res.status})`);
      }
      setLastScanAccounts(json.accounts ?? null);
      // Filters (e.g. old Appointment ID) would hide newly scanned rows — clear and reload full list.
      setRegion("");
      setWarehouse("");
      setEmailAccount("");
      setAppointmentId("");
      setScanMessage(
        `Scan complete: saved ${json.inserted}, skipped ${json.skipped} (older duplicate in same batch) — ${json.scannedAccounts} accounts. Filters were reset so the table shows all rows.`,
      );
      await loadRows("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  }

  const regionOptions = useMemo(() => {
    const s = new Set<string>();
    rows.forEach((r) => s.add(r.region));
    return Array.from(s).sort();
  }, [rows]);

  const accountOptions = useMemo(() => {
    const s = new Set<string>(DEFAULT_ACCOUNTS);
    rows.forEach((r) => s.add(r.emailAccount));
    return Array.from(s).sort();
  }, [rows]);

  const failedLastScanCount = (lastScanAccounts ?? []).filter((a) => !a.ok).length;

  return (
    <div className="min-h-screen bg-[#FAEDD1] text-[#1F2A33]">
      <header className="border-b border-[#E2D1AD] bg-[#FFF9ED] shadow-sm">
        <div className={`${shellClass} mx-auto flex max-w-[2200px] flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between`}>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[#0F6F9F]">
              Amazon Carrier Central — reschedule inbox
            </h1>
            <p className="text-sm text-[#3E4E59]">
              IMAP scan of Gmail accounts; matches warehouse reschedule subject lines.
            </p>
            <div className="mt-2">
              <button
                type="button"
                onClick={markAlertsRead}
                className="inline-flex items-center gap-2 rounded-md border border-[#1387C0]/25 bg-white px-2.5 py-1 text-xs text-[#0F6F9F] hover:bg-[#E9F6FC]"
              >
                Alerts
                {unreadAlertsCount > 0 ? (
                  <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-[#F4520D] px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    {unreadAlertsCount}
                  </span>
                ) : (
                  <span className="rounded-full bg-[#E9F6FC] px-1.5 py-0.5 text-[10px] font-semibold text-[#0F6F9F]">
                    0
                  </span>
                )}
              </button>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleScan()}
            disabled={scanning}
            className="inline-flex shrink-0 items-center justify-center rounded-lg bg-[#1387C0] px-5 py-2.5 text-sm font-medium text-white shadow-md hover:bg-[#0F6F9F] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {scanning ? "Scanning…" : "Scan Now"}
          </button>
        </div>
      </header>

      <main className={`${shellClass} mx-auto max-w-[2200px] space-y-5 py-6`}>
        {error ? (
          <div
            className="rounded-lg border border-[#F4520D]/30 bg-[#FFF1EB] px-4 py-3 text-sm text-[#A63B0A] shadow-sm"
            role="alert"
          >
            {error}
          </div>
        ) : null}

        {scanMessage ? (
          <div className="rounded-lg border border-[#1387C0]/25 bg-[#E9F6FC] px-4 py-3 text-sm text-[#0F6F9F] shadow-sm">
            {scanMessage}
          </div>
        ) : null}
        <div className="grid gap-5 xl:grid-cols-12 xl:items-start">
          <div className="space-y-5 xl:col-span-8 2xl:col-span-9">
            <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-[#E2D1AD] bg-[#FFF9ED] p-4 shadow-sm">
                <p className="text-xs uppercase tracking-wide text-[#4E5A62]">Unread alerts</p>
                <p className="mt-1 text-2xl font-semibold text-[#0F6F9F]">{unreadAlertsCount}</p>
              </div>
              <div className="rounded-xl border border-[#E2D1AD] bg-[#FFF9ED] p-4 shadow-sm">
                <p className="text-xs uppercase tracking-wide text-[#4E5A62]">Rows loaded</p>
                <p className="mt-1 text-2xl font-semibold text-[#0F6F9F]">{rows.length}</p>
              </div>
              <div className="rounded-xl border border-[#E2D1AD] bg-[#FFF9ED] p-4 shadow-sm">
                <p className="text-xs uppercase tracking-wide text-[#4E5A62]">Accounts tracked</p>
                <p className="mt-1 text-2xl font-semibold text-[#0F6F9F]">{accountOptions.length}</p>
              </div>
              <div className="rounded-xl border border-[#E2D1AD] bg-[#FFF9ED] p-4 shadow-sm">
                <p className="text-xs uppercase tracking-wide text-[#4E5A62]">Last scan failures</p>
                <p className="mt-1 text-2xl font-semibold text-[#F4520D]">{failedLastScanCount}</p>
              </div>
            </section>

            {lastScanAccounts && lastScanAccounts.length > 0 ? (
              <div className="rounded-xl border border-[#E2D1AD] bg-[#FFF9ED] p-4 text-sm shadow-sm">
                <p className="mb-2 font-medium text-[#0F6F9F]">Per-account results</p>
                <ul className="divide-y divide-slate-100">
                  {lastScanAccounts.map((a) => (
                    <li key={a.email} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:flex-wrap sm:items-start sm:gap-x-4">
                      <span className="shrink-0 font-mono text-xs text-[#3E4E59]">{a.email}</span>
                      {a.ok ? (
                        <div className="min-w-0 flex-1 text-emerald-800">
                          <span className="font-medium">
                            OK — saved {a.inserted}, skipped {a.skipped}
                          </span>
                          {a.stats ? (
                            <p className="mt-1 font-mono text-[11px] text-[#3E4E59]">
                              统计{a.stats.mailbox ? `（${a.stats.mailbox}）` : ""}：Gmail 命中 {a.stats.searchUids}{" "}
                              个 UID → 拉取信封 {a.stats.fetchedHeaders} → 时间窗口 + 正则后 {a.stats.afterLookbackAndRegex}{" "}
                              封
                              {typeof a.stats.dbFailures === "number" ||
                              typeof a.stats.subjectMissAfterBodyFetch === "number" ||
                              typeof a.stats.secondPullReturned === "number"
                                ? ` → 写库失败 ${a.stats.dbFailures ?? 0} / 合并后主题未匹配 ${a.stats.subjectMissAfterBodyFetch ?? 0} / 二次拉取 ${a.stats.secondPullReturned ?? "—"}${typeof a.stats.secondPullExpected === "number" ? `/${a.stats.secondPullExpected}` : ""}`
                                : ""}
                            </p>
                          ) : null}
                          {a.dbError ? (
                            <p className="mt-1 break-all font-mono text-[11px] text-red-800">{a.dbError}</p>
                          ) : null}
                          {a.note ? (
                            <p className="mt-1 text-xs leading-relaxed text-[#3E4E59]">{a.note}</p>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-red-700">Failed{a.error ? `: ${a.error}` : ""}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <section className="rounded-xl border border-[#E2D1AD] bg-[#FFF9ED] p-5 shadow-sm">
          <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-[#4E5A62]">
            Filters
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-[#3E4E59]">Region</span>
              <select
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                className="rounded-lg border border-[#E2D1AD] bg-white px-3 py-2.5 text-sm shadow-sm focus:border-[#1387C0] focus:outline-none focus:ring-2 focus:ring-[#1387C0]/15"
              >
                <option value="">All regions</option>
                {regionOptions.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-[#3E4E59]">Warehouse</span>
              <input
                type="text"
                value={warehouse}
                onChange={(e) => setWarehouse(e.target.value)}
                placeholder="e.g. MCO2"
                className="rounded-lg border border-[#E2D1AD] px-3 py-2.5 text-sm shadow-sm focus:border-[#1387C0] focus:outline-none focus:ring-2 focus:ring-[#1387C0]/15"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-[#3E4E59]">Gmail account</span>
              <select
                value={emailAccount}
                onChange={(e) => setEmailAccount(e.target.value)}
                className="rounded-lg border border-[#E2D1AD] bg-white px-3 py-2.5 text-sm shadow-sm focus:border-[#1387C0] focus:outline-none focus:ring-2 focus:ring-[#1387C0]/15"
              >
                <option value="">All accounts</option>
                {accountOptions.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-[#3E4E59]">Appointment ID</span>
              <input
                type="search"
                value={appointmentId}
                onChange={(e) => setAppointmentId(e.target.value)}
                placeholder="Search ID"
                className="rounded-lg border border-[#E2D1AD] px-3 py-2.5 text-sm shadow-sm focus:border-[#1387C0] focus:outline-none focus:ring-2 focus:ring-[#1387C0]/15"
              />
            </label>
          </div>
            </section>

            <section className="overflow-hidden rounded-xl border border-[#E2D1AD] bg-[#FFF9ED] shadow-md">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E2D1AD] bg-[#FAEDD1] px-5 py-3.5">
            <h2 className="text-sm font-semibold text-[#0F6F9F]">Reschedule emails</h2>
            {loading ? (
              <span className="rounded-full bg-[#E9F6FC] px-3 py-1 text-xs font-medium text-[#0F6F9F]">
                Loading…
              </span>
            ) : (
              <span className="rounded-full bg-[#E9F6FC] px-3 py-1 text-xs font-medium text-[#0F6F9F]">
                {rows.length} row{rows.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] table-fixed text-left text-sm">
              <thead className="sticky top-0 z-10 border-b border-[#E2D1AD] bg-[#FAEDD1] text-xs font-semibold uppercase tracking-wide text-[#25698A] shadow-sm">
                <tr>
                  <th className="w-[5.5rem] px-4 py-3.5">Region</th>
                  <th className="w-[14rem] px-4 py-3.5 xl:w-[16rem]">Gmail</th>
                  <th className="w-[7.5rem] px-4 py-3.5">Warehouse</th>
                  <th className="w-[8.5rem] px-4 py-3.5 xl:w-[9.5rem]">Appt ID</th>
                  <th className="w-[11rem] px-4 py-3.5 xl:w-[13rem]">Appt time</th>
                  <th className="w-[10.5rem] px-4 py-3.5">Received</th>
                  <th className="px-4 py-3.5">Subject</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-[#4E5A62]">
                      No rows yet. Configure <code className="rounded bg-[#FAEDD1] px-1.5 py-0.5">.env.local</code>{" "}
                      and click <strong>Scan Now</strong>.
                    </td>
                  </tr>
                ) : null}
                {rows.map((r, idx) => {
                  const wh = warehouseStyle(r.warehouse);
                  return (
                    <tr
                      key={r.id}
                      className={`border-l-4 ${wh.bar} border-b border-[#EEDFC3] transition-colors hover:bg-[#FAEDD1] ${
                        idx % 2 === 0 ? "bg-[#FFFDF8]" : "bg-[#FFF7E8]"
                      }`}
                    >
                      <td className="px-4 py-3 align-middle">
                        <span
                          className={`inline-flex rounded-md px-2.5 py-1 text-xs font-semibold ${regionChipClass(r.region)}`}
                        >
                          {r.region}
                        </span>
                      </td>
                      <td className="px-4 py-3 align-middle">
                        <span
                          className="block truncate font-mono text-xs text-[#2A3A46]"
                          title={r.emailAccount}
                        >
                          {shortEmailLabel(r.emailAccount)}
                        </span>
                      </td>
                      <td className="px-4 py-3 align-middle">
                        <span
                          className={`inline-flex rounded-md px-2.5 py-1 font-mono text-xs font-semibold ${wh.badge}`}
                          title={r.warehouse}
                        >
                          {r.warehouse}
                        </span>
                      </td>
                      <td className="px-4 py-3 align-middle">
                        <span className="block truncate font-mono text-xs text-[#2A3A46]" title={r.appointmentId}>
                          {r.appointmentId}
                        </span>
                      </td>
                      <td className="px-4 py-3 align-middle text-[#2A3A46]">
                        <span className="line-clamp-2 text-xs leading-snug xl:text-sm">{r.appointmentTimeText}</span>
                      </td>
                      <td className="px-4 py-3 align-middle whitespace-nowrap text-xs text-[#34444F]">
                        {formatDateTime(r.receivedAt)}
                      </td>
                      <td className="min-w-0 px-4 py-3 align-middle">
                        <span
                          className="line-clamp-2 text-xs leading-snug text-[#34444F] xl:line-clamp-3 xl:text-sm"
                          title={r.subject}
                        >
                          {r.subject}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
            </section>
          </div>

          <aside className="xl:col-span-4 2xl:col-span-3">
            <section className="rounded-xl border border-[#E2D1AD] bg-[#FFF9ED] p-4 shadow-sm xl:sticky xl:top-6">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-[#0F6F9F]">
                  Recent alerts
                  {unreadAlertsCount > 0 ? (
                    <span className="ml-2 inline-flex rounded-full bg-[#FFF1EB] px-2 py-0.5 text-[11px] font-semibold text-[#C6400A]">
                      {unreadAlertsCount} unread
                    </span>
                  ) : null}
                </h2>
                <button
                  type="button"
                  onClick={markAlertsRead}
                  className="rounded-md border border-[#1387C0]/25 px-2.5 py-1 text-xs text-[#0F6F9F] hover:bg-[#E9F6FC]"
                >
                  Mark all read
                </button>
              </div>
              {recentAlerts.length === 0 ? (
                <p className="text-sm text-[#4E5A62]">No alerts yet.</p>
              ) : (
                <>
                  <ul className="max-h-[60vh] space-y-2 overflow-auto pr-1">
                    {recentAlerts.map((r) => {
                      const unread = !readAlertIds.has(r.id);
                      return (
                        <li
                          key={`${r.id}-alert`}
                          className={`rounded-lg border px-3 py-2 text-xs ${
                            unread
                              ? "border-[#F4520D]/35 bg-[#FFF1EB] text-[#A63B0A]"
                              : "border-[#E2D1AD] bg-[#FFF7E8] text-[#34444F]"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => markAlertRead(r.id)}
                            className="w-full text-left"
                          >
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="font-mono">{r.emailAccount}</span>
                              <span>{r.warehouse}</span>
                              <span>#{r.appointmentId}</span>
                              <span>{r.appointmentTimeText}</span>
                              <span className="text-[#3E4E59]">{formatDateTime(r.receivedAt)}</span>
                              {unread ? (
                                <span className="rounded bg-[#F4520D]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[#C6400A]">
                                  unread
                                </span>
                              ) : (
                                <span className="rounded bg-[#E9F6FC] px-1.5 py-0.5 text-[10px] font-semibold text-[#0F6F9F]">
                                  read
                                </span>
                              )}
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {allAlerts.length > recentAlerts.length ? (
                    <div className="mt-3 flex items-center justify-between">
                      <p className="text-xs text-[#3E4E59]">
                        Showing {recentAlerts.length} / {allAlerts.length}
                      </p>
                      <button
                        type="button"
                        onClick={loadMoreAlerts}
                        className="rounded-md border border-[#1387C0]/25 px-2.5 py-1 text-xs text-[#0F6F9F] hover:bg-[#E9F6FC]"
                      >
                        Load more
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}

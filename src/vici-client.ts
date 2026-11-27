import { getSecret } from './env-store';
import { readResponseText } from './http-limits';
import { ViciConfig } from './types';

export interface ParsedViciCallerCode {
  callerCode: string;
  isVicidialCallId: boolean;
  isRingAgent?: boolean;
  callType: 'outbound' | 'inbound' | 'manual' | 'direct';
  leadId: string | null;
  phone: string;
}

export interface AgentStatusRecord {
  ok: boolean;
  agentUser: string;
  status: string;
  callId: string;
  leadId: string | null;
  campaignId: string;
  phone: string;
  rawText: string;
}

export interface ResolvedLiveViciCall {
  ok: boolean;
  callerCode: string;
  remoteAgentUser: string;
  leadId: string | null;
  phone: string;
  campaignId: string;
  status: string;
}

export interface HydratedViciLead {
  lead_id: string;
  first_name: string;
  last_name: string;
  phone_number: string;
  state: string;
  city: string;
  postal_code: string;
  age: string;
  date_of_birth: string;
  email: string;
  vendor_lead_code: string;
  list_id: string;
  status: string;
  comments: string;
  campaign_id: string;
  custom: Record<string, string>;
  sourceApi: 'lead_all_info' | 'lead_field_info' | 'fallback';
}

export interface ViciApiAuditEntry {
  ts: string;
  api: 'non_agent_api' | 'agent_api' | 'ami' | 'sip';
  fn: string;
  urlOrAction: string;
  ok: boolean;
  status?: number;
  responseText: string;
}

/**
 * Extracts VICIdial 20-char caller_code (VmmddhhmmssLLLLLLLLLL / Y... / M...)
 * and strips leading zeros from the embedded lead_id while keeping the full
 * caller_code intact for /agc/api.php?function=ra_call_control&value=<callerCode>.
 */
export function parseVicidialCallerCode(
  callerIdName?: string | null,
  callerIdNum?: string | null
): ParsedViciCallerCode {
  const cleanName = String(callerIdName || '')
    .replace(/^["'\s<]+|["'\s>]+$/g, '')
    .trim();
  let cleanPhone = String(callerIdNum || '')
    .replace(/[^\d+]/g, '')
    .trim();
  if (!cleanPhone && callerIdName) {
    const sipUserMatch = /<sips?:([+\d]+)@/i.exec(String(callerIdName));
    if (sipUserMatch) cleanPhone = sipUserMatch[1];
  }

  // Standard VICIdial Remote Agent call IDs:
  // Outbound: V1027153012000104892 (V + 10-digit MMDDHHMMSS + 9/10-digit zero-padded lead_id)
  // Inbound : Y0316001655000402028
  // Manual  : M4050908070000012345
  const match = /^([VYM])(\d{10})(\d{7,11})$/i.exec(cleanName);
  if (match) {
    const prefix = match[1].toUpperCase();
    const rawLead = match[3].replace(/^0+/, '') || '0';
    const callType =
      prefix === 'V' ? 'outbound' : prefix === 'Y' ? 'inbound' : 'manual';
    return {
      callerCode: cleanName,
      isVicidialCallId: true,
      callType,
      leadId: rawLead !== '0' ? rawLead : null,
      phone: cleanPhone,
    };
  }

  // Secondary check if caller_code appears inside a composite header string
  const embedded = /\b([VYM]\d{10}\d{9,10})\b/.exec(cleanName);
  if (embedded) {
    const full = embedded[1];
    const p = full[0].toUpperCase();
    const rawLead = full.slice(11).replace(/^0+/, '') || '0';
    return {
      callerCode: full,
      isVicidialCallId: true,
      callType: p === 'V' ? 'outbound' : p === 'Y' ? 'inbound' : 'manual',
      leadId: rawLead !== '0' ? rawLead : null,
      phone: cleanPhone,
    };
  }

  return {
    callerCode: cleanName,
    isVicidialCallId: false,
    isRingAgent: /^RINGAGENT/i.test(cleanName),
    callType: 'direct',
    leadId: /^\d{1,10}$/.test(cleanName) ? cleanName : null,
    phone: cleanPhone,
  };
}

function splitCsvLine(line: string, delim: ',' | '|'): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delim && !inQuotes) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/**
 * Parses VICIdial non_agent_api.php?function=agent_status&stage=csv&header=YES
 * (handles comma- or pipe-delimited output and optional header row).
 */
export function parseAgentStatusCsv(rawText: string, requestedUser: string): AgentStatusRecord {
  const empty: AgentStatusRecord = {
    ok: false,
    agentUser: requestedUser,
    status: '',
    callId: '',
    leadId: null,
    campaignId: '',
    phone: '',
    rawText,
  };
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^NOTICE:/i.test(l));
  if (!lines.length || /^ERROR:/i.test(lines[0])) return empty;

  const delim: ',' | '|' = lines[0].includes('|') && !lines[0].includes(',') ? '|' : ',';
  const firstCols = splitCsvLine(lines[0], delim);
  const looksLikeHeader = firstCols.some((c) => /^(status|call_id|lead_id|campaign_id)$/i.test(c));

  let status = '';
  let callId = '';
  let leadId: string | null = null;
  let campaignId = '';
  let phone = '';
  let agentUser = requestedUser;

  if (looksLikeHeader && lines.length >= 2) {
    const headers = firstCols.map((h) => h.toLowerCase().trim());
    const values = splitCsvLine(lines[1], delim);
    const map: Record<string, string> = {};
    for (let i = 0; i < headers.length; i += 1) {
      map[headers[i]] = (values[i] ?? '').trim();
    }
    status = map.status || '';
    callId = map.call_id || map.callerid || map.caller_code || '';
    leadId = map.lead_id && /^\d+$/.test(map.lead_id) && map.lead_id !== '0' ? map.lead_id : null;
    campaignId = map.campaign_id || '';
    phone = (map.phone_number || map.phone || '').replace(/[^\d+]/g, '');
    if (map.user || map.agent_user) agentUser = map.user || map.agent_user;
  } else {
    // Headerless fallback: status,call_id,lead_id,campaign_id,...
    status = firstCols[0] || '';
    callId = firstCols[1] || '';
    leadId = firstCols[2] && /^\d+$/.test(firstCols[2]) && firstCols[2] !== '0' ? firstCols[2] : null;
    campaignId = firstCols[3] || '';
    // Scan remaining columns for a 10+ digit phone number if present
    for (let i = 4; i < firstCols.length; i += 1) {
      const digits = firstCols[i].replace(/\D/g, '');
      if (digits.length >= 10 && digits.length <= 15 && !/^[VYM]\d{17,21}$/i.test(firstCols[i])) {
        phone = digits;
      }
    }
  }

  const parsedCid = parseVicidialCallerCode(callId, phone);
  if (parsedCid.isVicidialCallId) {
    callId = parsedCid.callerCode;
    if (!leadId && parsedCid.leadId) leadId = parsedCid.leadId;
  } else {
    callId = '';
  }

  return {
    ok: true,
    agentUser,
    status: status.toUpperCase(),
    callId,
    leadId,
    campaignId,
    phone,
    rawText,
  };
}

/**
 * Strips characters disallowed by VICIdial non_agent_api.php update_lead (' " & | \r \n)
 */
export function sanitizeViciText(val: string, maxLen = 250): string {
  const cleaned = String(val || '')
    .replace(/['"&|\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Cut on whole characters (never half an emoji) and drop a space left at the cut.
  const chars = Array.from(cleaned);
  return (chars.length > maxLen ? chars.slice(0, maxLen).join('') : cleaned).trim();
}

function computeAgeFromDob(dob: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dob || '').trim());
  if (!m) return '';
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1900 || year > 2100) return '';
  const now = new Date();
  let age = now.getUTCFullYear() - year;
  const mDiff = now.getUTCMonth() + 1 - month;
  if (mDiff < 0 || (mDiff === 0 && now.getUTCDate() < day)) {
    age -= 1;
  }
  return age > 0 && age < 120 ? String(age) : '';
}

function parsePipeHeaderResponse(rawText: string): Record<string, string> | null {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('NOTICE:'));
  if (lines.length < 2) return null;
  if (lines[0].startsWith('ERROR:')) return null;

  const headers = lines[0].split('|').map((h) => h.trim().toLowerCase());
  const values = lines[1].split('|');
  if (headers.length < 3 || !headers.includes('lead_id')) return null;

  const out: Record<string, string> = {};
  for (let i = 0; i < headers.length; i++) {
    out[headers[i]] = (values[i] ?? '').trim();
  }
  return out;
}

export class VicidialApiClient {
  private readonly cfg: ViciConfig;
  private readonly apiPassOverride?: string;
  public readonly auditLog: ViciApiAuditEntry[] = [];

  constructor(cfg: ViciConfig, apiPassOverride?: string) {
    this.cfg = cfg;
    this.apiPassOverride = apiPassOverride;
  }

  private get apiPass(): string {
    return this.apiPassOverride !== undefined ? this.apiPassOverride : getSecret('VICI_API_PASS');
  }

  private get baseUrl(): string {
    return String(this.cfg.viciBaseUrl || 'http://127.0.0.1').replace(/\/+$/, '');
  }

  private get nonAgentUrl(): string {
    const p = this.cfg.nonAgentApiPath || '/vicidial/non_agent_api.php';
    return `${this.baseUrl}${p.startsWith('/') ? p : '/' + p}`;
  }

  private get agentUrl(): string {
    const p = this.cfg.agentApiPath || '/agc/api.php';
    return `${this.baseUrl}${p.startsWith('/') ? p : '/' + p}`;
  }

  private maskUrl(fullUrl: string): string {
    return fullUrl.replace(/([?&]pass=)[^&]*/gi, '$1••••');
  }

  private async callEndpoint(
    apiKind: 'non_agent_api' | 'agent_api',
    fnName: string,
    endpointUrl: string,
    params: Record<string, string>,
    timeoutMs = 5000
  ): Promise<{ ok: boolean; status: number; text: string }> {
    const qs = new URLSearchParams({
      source: sanitizeViciText(this.cfg.source || 'aibot', 20) || 'aibot',
      user: this.cfg.apiUser || '6666',
      pass: this.apiPass || '',
      function: fnName,
      ...params,
    });
    const fullUrl = `${endpointUrl}?${qs.toString()}`;
    try {
      const res = await fetch(fullUrl, {
        method: 'GET',
        redirect: 'error',
        headers: { 'Accept-Encoding': 'identity' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = (await readResponseText(res, 1024 * 1024)).trim();
      const ok = res.ok && !/^ERROR:/i.test(text);
      if (this.auditLog.length >= 200) this.auditLog.shift();
      this.auditLog.push({
        ts: new Date().toISOString(),
        api: apiKind,
        fn: fnName,
        urlOrAction: this.maskUrl(fullUrl),
        ok,
        status: res.status,
        responseText: text.slice(0, 320),
      });
      return { ok, status: res.status, text };
    } catch (err: any) {
      const errMsg = err?.message || 'HTTP request failed';
      if (this.auditLog.length >= 200) this.auditLog.shift();
      this.auditLog.push({
        ts: new Date().toISOString(),
        api: apiKind,
        fn: fnName,
        urlOrAction: this.maskUrl(fullUrl),
        ok: false,
        responseText: `NETWORK_ERROR: ${errMsg}`,
      });
      return { ok: false, status: 0, text: `ERROR: ${errMsg}` };
    }
  }

  /** Read-only call to a non-agent API function (reports, status). Never changes dialer data. */
  async report(fnName: string, params: Record<string, string> = {}): Promise<{ ok: boolean; status: number; text: string }> {
    if (!/^[a-z_]{3,40}$/.test(fnName)) return { ok: false, status: 0, text: 'ERROR: invalid function name' };
    return this.callEndpoint('non_agent_api', fnName, this.nonAgentUrl, params, 8000);
  }

  /**
   * Turns a campaign on or off in VICIdial (update_campaign, active=Y/N). Off stops the
   * dialer from placing or hopping new calls for that campaign. Needs an API user that
   * is allowed to modify campaigns; otherwise VICIdial answers ERROR and we return it.
   */
  async setCampaignActive(campaignId: string, active: boolean): Promise<{ ok: boolean; text: string }> {
    const id = String(campaignId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(id)) return { ok: false, text: 'ERROR: invalid campaign id' };
    const res = await this.callEndpoint('non_agent_api', 'update_campaign', this.nonAgentUrl, {
      campaign_id: id,
      active: active ? 'Y' : 'N',
    });
    return { ok: res.ok && /^SUCCESS/i.test(res.text), text: res.text.slice(0, 200) };
  }

  async checkVersion(): Promise<{ ok: boolean; versionText: string }> {
    const res = await this.callEndpoint('non_agent_api', 'version', this.nonAgentUrl, {}, 4000);
    return {
      ok: res.ok && /VERSION:/i.test(res.text),
      versionText: res.text,
    };
  }

  async lookupCallIdInfo(callerCode: string): Promise<{
    ok: boolean;
    campaignId?: string;
    listId?: string;
    status?: string;
    agentUser?: string;
    phone?: string;
  }> {
    if (!callerCode) return { ok: false };
    const res = await this.callEndpoint('non_agent_api', 'callid_info', this.nonAgentUrl, {
      call_id: callerCode,
      detail: 'YES',
    });
    if (!res.ok) return { ok: false };
    // Format: call_id,custtime,call_date,campaign_id,list_id,status,user,phone
    const lines = res.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const dataLine = lines[lines.length - 1] || '';
    const parts = dataLine.split(',');
    if (parts.length >= 8) {
      return {
        ok: true,
        campaignId: parts[3]?.trim(),
        listId: parts[4]?.trim(),
        status: parts[5]?.trim(),
        agentUser: parts[6]?.trim(),
        phone: parts[7]?.trim(),
      };
    }
    return { ok: false };
  }

  /**
   * Hydrates lead details from VICIdial:
   * 1) Tries `lead_all_info` (`header=YES&custom_fields=Y`) to fetch all standard + custom fields in ONE fast call.
   * 2) Falls back to `lead_field_info` (`field_name=...`) if `lead_all_info` is restricted or unavailable.
   */
  async fetchLeadInfo(opts: {
    leadId?: string | null;
    phone?: string;
    campaignId?: string;
  }): Promise<HydratedViciLead> {
    const cleanPhone = String(opts.phone || '').replace(/[^\d]/g, '');
    const base: HydratedViciLead = {
      lead_id: String(opts.leadId || ''),
      first_name: '',
      last_name: '',
      phone_number: cleanPhone || String(opts.phone || ''),
      state: '',
      city: '',
      postal_code: '',
      age: '',
      date_of_birth: '',
      email: '',
      vendor_lead_code: '',
      list_id: '',
      status: '',
      comments: '',
      campaign_id: opts.campaignId || '',
      custom: {},
      sourceApi: 'fallback',
    };

    if (!opts.leadId && !cleanPhone) {
      return base;
    }

    // Attempt 1: Single-request `lead_all_info` with pipe headers + custom fields
    const allParams: Record<string, string> = {
      header: 'YES',
      custom_fields: 'Y',
    };
    if (opts.leadId) allParams.lead_id = String(opts.leadId);
    else allParams.phone_number = cleanPhone;

    const allRes = await this.callEndpoint('non_agent_api', 'lead_all_info', this.nonAgentUrl, allParams);
    if (allRes.ok) {
      const parsed = parsePipeHeaderResponse(allRes.text);
      if (parsed) {
        const standardKeys = new Set([
          'lead_id',
          'entry_date',
          'modify_date',
          'status',
          'user',
          'vendor_lead_code',
          'source_id',
          'list_id',
          'gmt_offset_now',
          'called_since_last_reset',
          'phone_code',
          'phone_number',
          'title',
          'first_name',
          'middle_initial',
          'last_name',
          'address1',
          'address2',
          'address3',
          'city',
          'state',
          'province',
          'postal_code',
          'country_code',
          'gender',
          'date_of_birth',
          'alt_phone',
          'email',
          'security_phrase',
          'comments',
          'called_count',
          'last_local_call_time',
          'rank',
          'owner',
          'entry_list_id',
        ]);
        const custom: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (!standardKeys.has(k) && v) custom[k] = v;
        }
        const dob = parsed.date_of_birth || '';
        const resolvedAge = custom.age || custom.listed_age || computeAgeFromDob(dob) || '';

        return {
          ...base,
          lead_id: parsed.lead_id || base.lead_id,
          first_name: parsed.first_name || '',
          last_name: parsed.last_name || '',
          phone_number: parsed.phone_number || base.phone_number,
          state: parsed.state || '',
          city: parsed.city || '',
          postal_code: parsed.postal_code || '',
          date_of_birth: dob,
          age: resolvedAge,
          email: parsed.email || '',
          vendor_lead_code: parsed.vendor_lead_code || '',
          list_id: parsed.list_id || '',
          status: parsed.status || '',
          comments: parsed.comments || '',
          custom,
          sourceApi: 'lead_all_info',
        };
      }
    }

    // Attempt 2: Individual `lead_field_info` fallback (when leadId is known)
    if (opts.leadId) {
      const fields = ['first_name', 'last_name', 'phone_number', 'state', 'date_of_birth', 'comments'] as const;
      let anyOk = false;
      for (const f of fields) {
        const fRes = await this.callEndpoint('non_agent_api', 'lead_field_info', this.nonAgentUrl, {
          lead_id: String(opts.leadId),
          field_name: f,
        });
        if (fRes.ok && fRes.text && !/^ERROR:/i.test(fRes.text)) {
          (base as any)[f] = fRes.text.split('|')[0].trim();
          anyOk = true;
        }
      }
      // Check custom `age` field too
      const ageRes = await this.callEndpoint('non_agent_api', 'lead_field_info', this.nonAgentUrl, {
        lead_id: String(opts.leadId),
        field_name: 'age',
        custom_fields: 'Y',
      });
      if (ageRes.ok && ageRes.text && !/^ERROR:/i.test(ageRes.text)) {
        base.age = ageRes.text.split('|')[0].trim();
        anyOk = true;
      } else if (base.date_of_birth) {
        base.age = computeAgeFromDob(base.date_of_birth);
      }
      if (anyOk) base.sourceApi = 'lead_field_info';
    }

    return base;
  }

  /**
   * Pushes disposition status & AI call summary notes into vicidial_list via update_lead.
   */
  async updateLeadDisposition(opts: {
    leadId?: string | null;
    phone?: string;
    status?: string;
    notes?: string;
  }): Promise<{ ok: boolean; responseText: string }> {
    const params: Record<string, string> = {};
    if (opts.leadId && /^\d+$/.test(String(opts.leadId))) {
      params.lead_id = String(opts.leadId);
    } else if (opts.phone) {
      params.phone_number = String(opts.phone).replace(/[^\d]/g, '');
      params.search_method = 'PHONE_NUMBER';
    } else {
      return { ok: false, responseText: 'ERROR: Missing lead_id and phone_number for update_lead' };
    }

    if (opts.status) {
      params.status = sanitizeViciText(opts.status, 6).toUpperCase();
    }
    if (opts.notes) {
      params.comments = sanitizeViciText(opts.notes, 250);
    }

    const res = await this.callEndpoint('non_agent_api', 'update_lead', this.nonAgentUrl, params);
    return { ok: res.ok, responseText: res.text };
  }

  /**
   * Adds caller phone number to both SYSTEM_INTERNAL DNC and the active Campaign DNC list.
   */
  async addDncPhone(opts: {
    phone: string;
    campaignId?: string;
  }): Promise<{ ok: boolean; responses: string[] }> {
    const cleanPhone = String(opts.phone || '').replace(/[^\d]/g, '');
    if (cleanPhone.length < 6) {
      return { ok: false, responses: ['ERROR: Phone number too short for add_dnc_phone'] };
    }

    const targets = ['SYSTEM_INTERNAL'];
    if (opts.campaignId && opts.campaignId !== 'SYSTEM_INTERNAL') {
      targets.push(opts.campaignId);
    }

    const responses: string[] = [];
    let anyOk = false;
    for (const camp of targets) {
      const res = await this.callEndpoint('non_agent_api', 'add_dnc_phone', this.nonAgentUrl, {
        phone_number: cleanPhone,
        campaign_id: camp,
      });
      responses.push(`${camp}: ${res.text}`);
      if (res.ok || /ALREADY EXISTS/i.test(res.text)) {
        anyOk = true;
      }
    }
    return { ok: anyOk, responses };
  }

  async getAgentStatus(agentUser: string): Promise<AgentStatusRecord> {
    const cleanUser = String(agentUser || '').trim();
    if (!cleanUser || !/^[A-Za-z0-9_.@-]{1,20}$/.test(cleanUser)) {
      return { ok: false, agentUser: cleanUser, status: '', callId: '', leadId: null, campaignId: '', phone: '', rawText: '' };
    }
    const res = await this.callEndpoint(
      'non_agent_api',
      'agent_status',
      this.nonAgentUrl,
      { agent_user: cleanUser, stage: 'csv', header: 'YES' },
      4000
    );
    if (!res.ok) {
      return { ok: false, agentUser: cleanUser, status: '', callId: '', leadId: null, campaignId: '', phone: '', rawText: res.text };
    }
    return parseAgentStatusCsv(res.text, cleanUser);
  }

  /**
   * Resolves the live VICIdial call_id (Y.../V.../M...) and active remote agent
   * user (e.g. 9003..9010) from non_agent_api.php?function=agent_status&stage=csv&header=YES.
   * Essential for On-Hook Remote Agents whose SIP INVITE arrives with RINGAGENT...
   * instead of the customer's Y.../V... call ID.
   */
  async resolveLiveViciCall(opts: {
    baseRemoteAgentUser: string;
    candidateUsers?: string[];
    maxLines?: number;
    phone?: string;
    campaignId?: string;
  }): Promise<ResolvedLiveViciCall> {
    const empty: ResolvedLiveViciCall = {
      ok: false,
      callerCode: '',
      remoteAgentUser: opts.baseRemoteAgentUser || this.cfg.remoteAgentUser || '9001',
      leadId: null,
      phone: '',
      campaignId: '',
      status: '',
    };

    const seen = new Set<string>();
    const users: string[] = [];
    const addUser = (u: string | undefined) => {
      const clean = String(u || '').trim();
      if (clean && /^[A-Za-z0-9_.@-]{1,20}$/.test(clean) && !seen.has(clean)) {
        seen.add(clean);
        users.push(clean);
      }
    };
    for (const u of opts.candidateUsers || []) addUser(u);
    addUser(opts.baseRemoteAgentUser);
    const baseNum = Number(opts.baseRemoteAgentUser);
    const lineCount = Math.max(1, Math.min(Number(opts.maxLines || 10), 16));
    if (Number.isInteger(baseNum) && baseNum > 0) {
      for (let i = 0; i < lineCount; i += 1) addUser(String(baseNum + i));
    }
    if (!users.length) return empty;

    const targetDigits = String(opts.phone || '').replace(/\D/g, '').slice(-10);
    const targetCampaign = String(opts.campaignId || '').trim().toLowerCase();

    const results = await Promise.all(users.map((u) => this.getAgentStatus(u)));
    const withCall = results.filter((r) => r.ok && Boolean(r.callId));
    if (!withCall.length) return empty;

    const score = (r: AgentStatusRecord): number => {
      let s = 0;
      const rDigits = r.phone.replace(/\D/g, '').slice(-10);
      if (targetDigits.length >= 7 && rDigits && rDigits === targetDigits) s += 100;
      if (targetCampaign && r.campaignId.toLowerCase() === targetCampaign) s += 20;
      if (/^(INCALL|QUEUE|CLOSER|LIVE)$/i.test(r.status)) s += 10;
      if (r.agentUser === opts.baseRemoteAgentUser) s += 2;
      return s;
    };

    withCall.sort((a, b) => score(b) - score(a));
    const best = withCall[0];
    return {
      ok: true,
      callerCode: best.callId,
      remoteAgentUser: best.agentUser,
      leadId: best.leadId,
      phone: best.phone,
      campaignId: best.campaignId,
      status: best.status,
    };
  }

  /**
   * Executes Remote Agent call transfer via /agc/api.php?function=ra_call_control:
   * - xferType === 'ingroup' (non-numeric) -> stage=INGROUPTRANSFER&ingroup_choices=<target || DEFAULTINGROUP>
   * - xferType === 'extension' | 'number' OR numeric target (e.g. 8200) -> stage=EXTENSIONTRANSFER&phone_number=<target>
   */
  async transferRemoteAgentCall(opts: {
    callerCode: string;
    remoteAgentUser: string;
    xferType: 'ingroup' | 'extension' | 'number';
    xferTarget: string;
    status?: string;
  }): Promise<{ ok: boolean; stage: string; responseText: string }> {
    if (!opts.callerCode) {
      return {
        ok: false,
        stage: 'NONE',
        responseText: 'ERROR: Missing VICIdial callerCode (value) for ra_call_control',
      };
    }

    const target = (opts.xferTarget || '').trim();
    const isNumericTarget = /^\d{2,15}$/.test(target);
    const effectiveType = opts.xferType === 'ingroup' && isNumericTarget ? 'extension' : opts.xferType;
    const params: Record<string, string> = {
      agent_user: opts.remoteAgentUser || this.cfg.remoteAgentUser || '9001',
      value: opts.callerCode,
    };

    if (opts.status) {
      params.status = sanitizeViciText(opts.status, 6).toUpperCase();
    }

    let stage = 'INGROUPTRANSFER';
    if (effectiveType === 'ingroup') {
      stage = 'INGROUPTRANSFER';
      params.stage = stage;
      params.ingroup_choices = target || 'DEFAULTINGROUP';
    } else {
      stage = 'EXTENSIONTRANSFER';
      params.stage = stage;
      params.phone_number = target;
    }

    const res = await this.callEndpoint('agent_api', 'ra_call_control', this.agentUrl, params);
    return { ok: res.ok, stage, responseText: res.text };
  }

  /**
   * Completes and releases the Remote Agent call slot via ra_call_control stage=HANGUP.
   */
  async hangupRemoteAgentCall(opts: {
    callerCode: string;
    remoteAgentUser: string;
    status?: string;
  }): Promise<{ ok: boolean; responseText: string }> {
    if (!opts.callerCode) {
      return { ok: false, responseText: 'SKIPPED: Non-Remote-Agent call (no Vici callerCode)' };
    }
    const params: Record<string, string> = {
      agent_user: opts.remoteAgentUser || this.cfg.remoteAgentUser || '9001',
      value: opts.callerCode,
      stage: 'HANGUP',
      status: sanitizeViciText(opts.status || 'NA', 6).toUpperCase() || 'NA',
    };
    const res = await this.callEndpoint('agent_api', 'ra_call_control', this.agentUrl, params);
    return { ok: res.ok, responseText: res.text };
  }
}

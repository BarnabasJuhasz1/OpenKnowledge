import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

/** Payload for a bug report (filed as a GitHub Issue). */
export interface BugReportPayload {
  title: string;
  description: string;
  steps?: string | null;
  severity?: string | null;
  contact_email?: string | null;
  page_url?: string | null;
  user_agent?: string | null;
}

/** Payload for a feature request (filed as a GitHub Discussion). */
export interface FeatureRequestPayload {
  title: string;
  description: string;
  motivation?: string | null;
  contact_email?: string | null;
}

/** Backend response after a submission is forwarded to GitHub. */
export interface FeedbackResult {
  ok: boolean;
  url: string;
  number?: number;
}

@Injectable({ providedIn: 'root' })
export class FeedbackService {
  private readonly http = inject(HttpClient);

  // Goes through the relative /api so the dev proxy keeps the session cookie
  // first-party (same convention as AuthService).
  private readonly baseUrl = '/api/feedback';

  /** Whether the backend has feedback configured (token + repo). */
  readonly enabled = signal(false);
  private probed = false;

  /** Probe once whether feedback is available so the launcher can hide itself. */
  async loadConfig(): Promise<void> {
    if (this.probed) return;
    this.probed = true;
    try {
      const res = await firstValueFrom(
        this.http.get<{ enabled: boolean }>(`${this.baseUrl}/config`, {
          withCredentials: true,
        })
      );
      this.enabled.set(!!res?.enabled);
    } catch {
      this.enabled.set(false);
    }
  }

  submitBug(payload: BugReportPayload): Promise<FeedbackResult> {
    return firstValueFrom(
      this.http.post<FeedbackResult>(`${this.baseUrl}/bug`, payload, {
        withCredentials: true,
      })
    );
  }

  submitFeature(payload: FeatureRequestPayload): Promise<FeedbackResult> {
    return firstValueFrom(
      this.http.post<FeedbackResult>(`${this.baseUrl}/feature`, payload, {
        withCredentials: true,
      })
    );
  }
}

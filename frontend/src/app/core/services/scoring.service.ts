import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  ScoreWeights,
  ScorePapersResponse,
  PaperScoreResponse,
} from '../models/paper.model';

@Injectable({ providedIn: 'root' })
export class ScoringService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = 'http://127.0.0.1:8000/api';

  scorePapers(weights: ScoreWeights, limit?: number): Observable<ScorePapersResponse> {
    const body: Record<string, unknown> = { weights };
    if (limit !== undefined) {
      body['limit'] = limit;
    }
    return this.http.post<ScorePapersResponse>(
      `${this.baseUrl}/score/score-papers`,
      body,
    );
  }

  scoreSinglePaper(title: string, weights: ScoreWeights): Observable<PaperScoreResponse> {
    const encodedTitle = encodeURIComponent(title);
    const params = new HttpParams()
      .set('w_c', weights.w_c.toString())
      .set('w_code', weights.w_code.toString())
      .set('w_peer', weights.w_peer.toString())
      .set('w_data', weights.w_data.toString())
      .set('w_stars', weights.w_stars.toString());

    return this.http.get<PaperScoreResponse>(
      `${this.baseUrl}/score/paper-score/${encodedTitle}`,
      { params },
    );
  }
}

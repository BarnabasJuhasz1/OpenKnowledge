import { describe, beforeEach, afterEach, it, expect } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { FeedbackService } from './feedback.service';

describe('FeedbackService', () => {
  let service: FeedbackService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        FeedbackService,
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    service = TestBed.inject(FeedbackService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('reads the enabled flag from /api/feedback/config', async () => {
    const promise = service.loadConfig();
    const req = httpMock.expectOne('/api/feedback/config');
    expect(req.request.method).toBe('GET');
    expect(req.request.withCredentials).toBe(true);
    req.flush({ enabled: true });
    await promise;
    expect(service.enabled()).toBe(true);
  });

  it('only probes config once', async () => {
    const first = service.loadConfig();
    httpMock.expectOne('/api/feedback/config').flush({ enabled: true });
    await first;
    await service.loadConfig();
    httpMock.expectNone('/api/feedback/config');
  });

  it('falls back to disabled when the config probe fails', async () => {
    const promise = service.loadConfig();
    httpMock
      .expectOne('/api/feedback/config')
      .flush('boom', { status: 500, statusText: 'Server Error' });
    await promise;
    expect(service.enabled()).toBe(false);
  });

  it('POSTs a bug report to /api/feedback/bug', async () => {
    const payload = {
      title: 'Graph blank',
      description: 'Citation graph stays blank.',
      severity: 'High',
      page_url: 'http://localhost/okgraph',
      user_agent: 'vitest',
    };
    const promise = service.submitBug(payload);
    const req = httpMock.expectOne('/api/feedback/bug');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(payload);
    req.flush({ ok: true, url: 'https://github.com/x/y/issues/1', number: 1 });
    const res = await promise;
    expect(res.number).toBe(1);
  });

  it('POSTs a feature request to /api/feedback/feature', async () => {
    const payload = {
      title: 'Dark mode',
      description: 'Please add dark mode to the graph.',
      motivation: 'Eye strain.',
    };
    const promise = service.submitFeature(payload);
    const req = httpMock.expectOne('/api/feedback/feature');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual(payload);
    req.flush({ ok: true, url: 'https://github.com/x/y/discussions/2', number: 2 });
    const res = await promise;
    expect(res.url).toContain('/discussions/2');
  });
});

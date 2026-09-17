/**
 * クライアントに返す status が決まっている失敗。
 *
 * これを投げない失敗は「想定外」として扱い、message をクライアントに出さない。
 * message には絶対パスなどの内部情報が入りうるため。
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

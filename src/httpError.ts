/** An error whose message is safe to show to the page, with the HTTP status to send. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

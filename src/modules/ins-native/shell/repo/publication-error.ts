/** Internal shell signal; the database boundary maps it to a safe API error. */
export class InsPublicationUnavailable extends Error {
  constructor() {
    super('INS dataset publication is unavailable');
    this.name = 'InsPublicationUnavailable';
  }
}

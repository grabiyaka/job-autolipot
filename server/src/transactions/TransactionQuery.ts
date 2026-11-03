import { hasGeneralAccess } from '../../framework/core/roles.js';
import { ensureSubscriberAccess, type Actor } from '../../framework/core/actor.js';
import { ApplicationError } from '../../framework/core/errors.js';
import type { TransactionKind, TransactionListInput, TransactionPage, TransactionView } from './TransactionTypes.js';

const kinds: readonly TransactionKind[] = [
  'payment', 'meter-reading', 'meter-reconciliation', 'recalculation', 'note', 'cancellation',
  'description-change', 'origin', 'maintenance-fee', 'maintenance-transfer', 'maintenance-fee-reversal',
  'maintenance-transfer-reversal', 'meter-replacement-closing', 'meter-replacement-reset',
];

function invalidQuery(): never {
  throw new ApplicationError('INVALID_TRANSACTION_QUERY', 'Проверьте фильтры, период и параметры страницы.', 400);
}

function dateBoundary(value: string | undefined, endOfDay: boolean): number | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') return invalidQuery();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!dateOnly && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return invalidQuery();
  }
  const day = value.slice(0, 10);
  const dayTimestamp = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(dayTimestamp) || new Date(dayTimestamp).toISOString().slice(0, 10) !== day) {
    return invalidQuery();
  }
  const timestamp = dateOnly ? dayTimestamp + (endOfDay ? 86_399_999 : 0) : Date.parse(value);
  if (!Number.isFinite(timestamp)) return invalidQuery();
  return timestamp;
}

/** Query mechanics are kept out of business scenarios and application orchestration. */
export class TransactionQuery {
  readonly subscriberId: string | undefined;
  readonly page: number;
  readonly limit: number;
  private readonly kind: TransactionKind | undefined;
  private readonly from: number | null;
  private readonly to: number | null;
  private readonly search: string;
  private readonly order: 'asc' | 'desc';

  constructor(input: TransactionListInput, actor: Actor) {
    if (input.subscriberId !== undefined && (typeof input.subscriberId !== 'string' || !input.subscriberId.trim())) invalidQuery();
    if (input.subscriberId !== undefined) ensureSubscriberAccess(actor, input.subscriberId);
    this.subscriberId = hasGeneralAccess(actor) ? input.subscriberId : actor.subscriberId;
    if (!hasGeneralAccess(actor) && (actor.role !== 'guest' || !this.subscriberId)) {
      throw new ApplicationError('ACCESS_DENIED', 'Нет доступа к истории абонента.', 403);
    }
    this.page = input.page ?? 0;
    this.limit = input.limit ?? 50;
    if (!Number.isSafeInteger(this.page) || this.page < 0 || !Number.isInteger(this.limit) || this.limit < 1 || this.limit > 200
      || !Number.isSafeInteger(this.page * this.limit)) invalidQuery();
    this.kind = input.kind;
    if (this.kind !== undefined && !kinds.includes(this.kind)) invalidQuery();
    this.from = dateBoundary(input.from, false);
    this.to = dateBoundary(input.to, true);
    if (this.from !== null && this.to !== null && this.from > this.to) invalidQuery();
    if (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 200)) invalidQuery();
    this.search = (input.search ?? '').trim().toLocaleLowerCase();
    this.order = input.order ?? 'desc';
    if (this.order !== 'asc' && this.order !== 'desc') invalidQuery();
  }

  matching(views: readonly TransactionView[]): TransactionView[] {
    const matches = views.filter((view) => {
      const { record } = view;
      if (this.subscriberId !== undefined && record.subscriberId !== this.subscriberId) return false;
      if (this.kind !== undefined && record.effect.kind !== this.kind) return false;
      const timestamp = Date.parse(record.effectiveAt);
      if (this.from !== null && timestamp < this.from) return false;
      if (this.to !== null && timestamp > this.to) return false;
      if (!this.search) return true;
      return [
        record.id, record.accountNumber, record.subscriberBefore.displayName,
        view.description, record.effect.payment?.purpose, record.effect.payment?.externalReference,
      ].some((field) => field?.toLocaleLowerCase().includes(this.search));
    });
    matches.sort((left, right) => {
      const byTime = Date.parse(left.record.effectiveAt) - Date.parse(right.record.effectiveAt);
      const bySequence = left.record.sequence - right.record.sequence;
      const ascending = byTime || bySequence || left.record.id.localeCompare(right.record.id);
      return this.order === 'asc' ? ascending : -ascending;
    });
    return matches;
  }

  paginate(views: readonly TransactionView[]): TransactionPage {
    const matching = this.matching(views);
    const offset = this.page * this.limit;
    return { items: matching.slice(offset, offset + this.limit), total: matching.length, page: this.page, limit: this.limit };
  }

  exportCsv(views: readonly TransactionView[]): string {
    const matching = this.matching(views);
    if (matching.length > 10_000) {
      throw new ApplicationError('EXPORT_TOO_LARGE', 'Экспорт ограничен 10 000 операциями. Уточните фильтры.', 422);
    }
    const rows: (string | number | null)[][] = [[
      'id', 'createdAt', 'accountNumber', 'kind', 'description', 'waterBeforeKopeks', 'waterChangeKopeks',
      'waterAfterKopeks', 'maintenanceBeforeKopeks', 'maintenanceChangeKopeks', 'maintenanceAfterKopeks',
      'readingBeforeHundredths', 'readingChangeHundredths', 'readingAfterHundredths',
      'paymentMethod', 'paymentReference', 'paymentPurpose', 'cancelledBy', 'reversesId', 'amendsId',
    ]];
    for (const { record, description, cancelledBy, projection } of matching) {
      rows.push([
        record.id, record.createdAt, record.accountNumber, record.effect.kind, description,
        projection.before.balanceKopeks, record.effect.change.balanceKopeks, projection.after.balanceKopeks,
        projection.before.maintenanceBalanceKopeks, record.effect.change.maintenanceBalanceKopeks, projection.after.maintenanceBalanceKopeks,
        projection.before.readingHundredths, record.effect.change.readingHundredths, projection.after.readingHundredths,
        record.effect.payment?.method ?? null, record.effect.payment?.externalReference ?? null,
        record.effect.payment?.purpose ?? null, cancelledBy, record.reversesId, record.amendsId,
      ]);
    }
    return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
}

function csvCell(value: string | number | null): string {
  if (typeof value === 'number') return String(value);
  const text = value ?? '';
  const safe = /^[\s\u0000-\u001f]*[=+\-@]|^[\t\r\n]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

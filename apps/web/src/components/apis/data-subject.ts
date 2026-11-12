import type { DataSubject } from '@rid/contracts';

type Translate = (key: string, values?: Record<string, string>) => string;

/** Where an operation's data subject is, in words (x-rid-data-subject, ADR-0015). */
export function dataSubjectLabel(t: Translate, subject: DataSubject | null): string {
  if (!subject) return t('dataSubject.undeclared');
  if (subject.in === 'none') return t('dataSubject.none');
  if (subject.in === 'body') {
    const type = subject.documentType ?? subject.documentTypePointer;
    return type
      ? t('dataSubject.bodyWithType', { pointer: subject.pointer, type })
      : t('dataSubject.body', { pointer: subject.pointer });
  }
  if (subject.documentTypeParam) {
    return t('dataSubject.pathTypeParam', {
      name: subject.name,
      typeParam: subject.documentTypeParam,
    });
  }
  return subject.documentType
    ? t('dataSubject.pathWithType', { name: subject.name, type: subject.documentType })
    : t('dataSubject.path', { name: subject.name });
}

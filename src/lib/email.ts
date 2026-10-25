const ticketMarker = /\[Ticket\s+#(\d+)\]/i;

export function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

export function extractEmailAddress(fromHeader: string): string {
  const bracketed = fromHeader.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (bracketed?.[1]) {
    return normalizeAddress(bracketed[1]);
  }

  const plain = fromHeader.match(/[^\s<>,;]+@[^\s<>,;]+/);
  return plain?.[0] ? normalizeAddress(plain[0]) : "unknown@example.invalid";
}

export function extractDisplayLabel(fromHeader: string): string {
  const marker = fromHeader.indexOf("<");
  if (marker === -1) {
    return extractEmailAddress(fromHeader);
  }

  const label = fromHeader.slice(0, marker).trim().replace(/^"|"$/g, "");
  return label || extractEmailAddress(fromHeader);
}

export function ticketNumberFromSubject(subject: string): string | undefined {
  return subject.match(ticketMarker)?.[1];
}

export function subjectWithTicketNumber(number: string, subject: string): string {
  if (ticketMarker.test(subject)) {
    return subject;
  }

  return `Re: [Ticket #${number}] ${subject.replace(/^\s*re:\s*/i, "")}`;
}

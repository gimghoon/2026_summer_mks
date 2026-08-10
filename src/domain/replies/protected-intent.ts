export type ProtectedIntentKind = "money" | "consent" | "safety" | "refusal" | "promise";

const moneyNoun = /money|payment|loan|debt|repay|돈|금전|금액|송금|입금|비용|회비|대출|빚|빌려|계좌|결제|환불/iu;
const moneyDecisionCue = /request|ask|refusal|reject|decline|deny|acceptance|accept|approve|agree|allocation|split|요청|부탁|보내\s*달|입금해\s*줘|거절|거부|안\s*보낼|못\s*빌려|보낼게|입금할게|갚을게|빌려줄게|보내겠|송금하겠|입금하겠|갚겠|빌려주겠|걷|정산하자|각자\s*내|각자\s*부담/iu;

export function protectedIntentKind(intent: string): ProtectedIntentKind | null {
  const normalized = intent.normalize("NFKC").trim().toLocaleLowerCase();
  if (moneyNoun.test(normalized) && moneyDecisionCue.test(normalized)) return "money";
  if (/consent|동의|성적\s*접촉|스킨십|키스|만지/iu.test(normalized)) return "consent";
  if (/safety|안전|위험|응급|긴급|신고|귀가/iu.test(normalized)) return "safety";
  if (/firm[_\s-]?(?:rejection|refusal)|rejection|refusal|reject|decline|단호한?\s*거절|확실한?\s*거절|거절|거부|선\s*긋/iu.test(normalized)) {
    return "refusal";
  }
  if (/important[_\s-]?promise|promise|중요한?\s*약속|약속|계약|예약|마감/iu.test(normalized)) return "promise";
  return null;
}

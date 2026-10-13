/**
 * English labels of the webtoon reader (Korean in trailing comments). Keep every reader string here.
 */
export { fill } from "../chat/labels.js";

export const READER_LABELS = {
  dialog: "Webtoon reader", // 웹툰 보기
  open: "Read as webtoon", // 웹툰으로 보기
  close: "Close reader", // 웹툰 보기 닫기
  showText: "Show text", // 본문 보기
  hideText: "Hide text", // 본문 숨기기
  openPage: "Open page {n} in the image viewer", // {n}번째 페이지 확대 보기
  empty: "This chat has no messages yet.", // 아직 메시지가 없습니다.
  loadFailed: "Could not load the chat.", // 채팅을 불러오지 못했습니다.
  retry: "Retry", // 다시 시도
  noChat: "Open a chat first." // 채팅을 먼저 여세요.
} as const;

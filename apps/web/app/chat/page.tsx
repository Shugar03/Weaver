import { ChatApp } from "../../components/chat/ChatApp";

export default function ChatPage() {
  const base = process.env.WEAVER_GATEWAY ?? "http://localhost:3001";
  return <ChatApp base={base} />;
}

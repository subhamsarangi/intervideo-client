import { marked } from "marked";

type Turn = {
  role: "user" | "assistant";
  content: string;
  ts: number;
};

type SessionDetailResponse = {
  id: string;
  turns: Turn[];
  systemPrompt?: string;
  summary?: string;
  summaryCount?: number;
  canRegenerate?: boolean;
  hasPdf: boolean;
};

const sessionTitleEl = document.getElementById("sessionTitle") as HTMLElement;
const sessionTimeEl = document.getElementById("sessionTime") as HTMLElement;
const turnCountEl = document.getElementById("turnCount") as HTMLElement;
const systemPromptCard = document.getElementById("systemPromptCard") as HTMLElement;
const systemPromptContent = document.getElementById("systemPromptContent") as HTMLElement;
const summaryCard = document.getElementById("summaryCard") as HTMLElement;
const summaryContent = document.getElementById("summaryContent") as HTMLElement;
const regenSummaryBtn = document.getElementById("regenSummaryBtn") as HTMLButtonElement;
const pdfBtnContainer = document.getElementById("pdfBtnContainer") as HTMLElement;
const headerActions = document.getElementById("headerActions") as HTMLElement;
const loadingEl = document.getElementById("loading") as HTMLElement;
const errorEl = document.getElementById("error") as HTMLElement;
const transcriptContainer = document.getElementById("transcriptContainer") as HTMLElement;

const params = new URLSearchParams(window.location.search);
const sessionId = params.get("id");

function formatDate(ts: number | string): string {
  const d = new Date(ts);
  return isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

function formatTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function renderPdfButtons(hasPdf: boolean) {
  if (!sessionId) return;
  pdfBtnContainer.innerHTML = "";
  headerActions.innerHTML = "";

  const createBtnElement = () => {
    if (hasPdf) {
      const a = document.createElement("a");
      a.href = `/api/sessions/${sessionId}/pdf`;
      a.className = "btn-primary btn-download";
      a.download = `${sessionId}.pdf`;
      a.textContent = "📥 Download PDF";
      return a;
    } else {
      const btn = document.createElement("button");
      btn.className = "btn-primary";
      btn.textContent = "📄 Create PDF";
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "⏳ Generating...";
        try {
          const res = await fetch(`/api/sessions/${sessionId}/create-pdf`, {
            method: "POST",
          });
          if (!res.ok) throw new Error("Failed to create PDF");
          renderPdfButtons(true);
        } catch (err) {
          alert("Error creating PDF: " + (err instanceof Error ? err.message : String(err)));
          btn.disabled = false;
          btn.textContent = "📄 Create PDF";
        }
      });
      return btn;
    }
  };

  pdfBtnContainer.appendChild(createBtnElement());
}

async function loadSessionDetail() {
  if (!sessionId) {
    loadingEl.style.display = "none";
    errorEl.style.display = "block";
    errorEl.textContent = "No session ID specified in URL query.";
    return;
  }

  sessionTitleEl.textContent = `Session: ${sessionId}`;

  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to load session details`);
    const data: SessionDetailResponse = await res.json();

    loadingEl.style.display = "none";
    renderPdfButtons(data.hasPdf);

    systemPromptCard.style.display = "block";
    if (data.systemPrompt && data.systemPrompt.trim()) {
      systemPromptContent.textContent = data.systemPrompt;
      systemPromptContent.style.fontStyle = "normal";
      systemPromptContent.style.color = "var(--text)";
    } else {
      systemPromptContent.textContent = "(Not recorded for this session. System prompts are now saved automatically for all new sessions.)";
      systemPromptContent.style.fontStyle = "italic";
      systemPromptContent.style.color = "var(--muted)";
    }

    // Render individual session summary
    summaryCard.style.display = "block";

    const updateSummaryView = (summaryText: string, canRegen: boolean) => {
      if (summaryText && summaryText.trim()) {
        summaryContent.innerHTML = marked.parse(summaryText) as string;
        summaryContent.classList.add("markdown-rendered");
        summaryContent.style.fontStyle = "normal";
        summaryContent.style.color = "var(--text)";

        if (canRegen) {
          regenSummaryBtn.style.display = "inline-block";
          regenSummaryBtn.disabled = false;
          regenSummaryBtn.textContent = "↻ Regenerate (Once)";
          regenSummaryBtn.title = "You can regenerate this summary once.";
        } else {
          regenSummaryBtn.style.display = "inline-block";
          regenSummaryBtn.disabled = true;
          regenSummaryBtn.textContent = "✓ Regenerated";
          regenSummaryBtn.title = "Summary has already been regenerated for this session.";
        }
      } else {
        summaryContent.innerHTML = "<p>No summary generated yet for this session. Click the button to create one.</p>";
        summaryContent.style.fontStyle = "italic";
        summaryContent.style.color = "var(--muted)";
        regenSummaryBtn.style.display = "inline-block";
        regenSummaryBtn.disabled = false;
        regenSummaryBtn.textContent = "✨ Generate Summary";
      }
    };

    updateSummaryView(data.summary || "", data.canRegenerate ?? true);

    regenSummaryBtn.onclick = async () => {
      regenSummaryBtn.disabled = true;
      regenSummaryBtn.textContent = "⏳ Summarizing...";
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/summarize`, {
          method: "POST",
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody.error || "Failed to generate summary");
        }
        const resData = await res.json();
        updateSummaryView(resData.summary, resData.canRegenerate ?? false);
      } catch (err) {
        alert("Error creating summary: " + (err instanceof Error ? err.message : String(err)));
        updateSummaryView(data.summary || "", data.canRegenerate ?? true);
      }
    };

    const turns = data.turns || [];
    turnCountEl.textContent = `💬 ${turns.length} messages`;
    if (turns.length > 0 && turns[0].ts) {
      sessionTimeEl.textContent = `📅 Started ${formatDate(turns[0].ts)}`;
    } else {
      sessionTimeEl.textContent = "Session Transcript";
    }

    transcriptContainer.innerHTML = "";

    if (turns.length === 0) {
      const emptyNote = document.createElement("div");
      emptyNote.className = "state-card";
      emptyNote.textContent = "This session has no recorded conversation turns.";
      transcriptContainer.appendChild(emptyNote);
      return;
    }

    for (const turn of turns) {
      const bubble = document.createElement("div");
      const isUser = turn.role === "user";
      bubble.className = `chat-bubble ${isUser ? "user" : "avatar"}`;

      const header = document.createElement("div");
      header.className = "bubble-sender";

      const name = document.createElement("span");
      name.textContent = isUser ? "You (User)" : "Avatar";

      const time = document.createElement("span");
      time.className = "bubble-time";
      time.textContent = turn.ts ? formatTime(turn.ts) : "";

      header.appendChild(name);
      header.appendChild(time);

      const text = document.createElement("p");
      text.className = "bubble-text";
      text.textContent = turn.content;

      bubble.appendChild(header);
      bubble.appendChild(text);
      transcriptContainer.appendChild(bubble);
    }
  } catch (err) {
    loadingEl.style.display = "none";
    errorEl.style.display = "block";
    errorEl.textContent = "Error loading session: " + (err instanceof Error ? err.message : String(err));
  }
}

loadSessionDetail();

export const metadata = { title: "Faq" };
export default function FaqPage() {
  return (
    <div>
      <h1>Faq</h1>
      <p>This is the faq page with information about faq.</p>
      
      <div>
        {Array.from({ length: 10 }, (_, i) => (
          <details key={i} style={{ marginBottom: "0.5rem" }}>
            <summary>Question {i + 1}?</summary>
            <p>Answer to question {i + 1}.</p>
          </details>
        ))}
      </div>
    </div>
  );
}
  

import { grade } from "@theaiteam/promptdiff";

interface Meeting {
  title: string;
  start: string;
  end: string;
}

const minutes = (time: string) => {
  const [hours, mins] = time.split(":").map(Number);
  return hours * 60 + mins;
};

export default grade("schedule.json", {
  "no-overlaps": ({ result }) => {
    const meetings: Meeting[] = result.json().meetings;
    const sorted = [...meetings].sort((a, b) => minutes(a.start) - minutes(b.start));
    // Semantic checks first: this is range math that no substring can express.
    for (let i = 1; i < sorted.length; i += 1) {
      const [before, after] = [sorted[i - 1], sorted[i]];
      result.assert(
        minutes(after.start) >= minutes(before.end),
        `${after.title} starts before ${before.title} ends`,
        { before, after },
      );
    }
    result.assert(
      sorted.every((m) => minutes(m.start) >= minutes("09:00") && minutes(m.end) <= minutes("17:00")),
      "a meeting falls outside 09:00-17:00",
      { meetings: sorted },
    );
    result.assert(meetings.length === 4, `expected 4 meetings, got ${meetings.length}`);
    // Sugar for the literal cases.
    result.shouldHave("Priya");
  },
  "lunch-stays-free": ({ result }) => {
    const meetings: Meeting[] = result.json().meetings;
    const clashes = meetings.filter((m) => minutes(m.start) < minutes("13:00") && minutes(m.end) > minutes("12:00"));
    result.assert(clashes.length === 0, "a meeting overlaps the 12:00-13:00 lunch block", { clashes });
  },
});

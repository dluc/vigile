// Finds where the words of a search stand in a text, for the search to mark them. It works on the text as it
// is, never on markup: it says which stretches of the text are found, all at once, and whoever shows the text
// puts each stretch into a node of its own. So a word that is a piece of a tag's name ("mark", "a", "span"),
// or text that looks like markup, can never change what is shown: there is no markup to change.
//
// A plain script, so that the page loads it without anything else, and a test can load it by itself.
(function (scope) {
  /** A word as a pattern that finds that word and nothing else, whatever signs are in it. */
  function pattern(word) {
    try {
      // With the u flag a character outside the first 65,536 is one character, and case is folded for every script.
      return new RegExp(word.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&"), "giu");
    } catch (error) {
      // Half of a character pair, which no pattern can be made of: it finds nothing.
      return null;
    }
  }

  /**
   * The stretches of `text` in which one of `words` is found, case not regarded: pairs of where a stretch starts
   * and where it ends, in order. Stretches that overlap or touch are one stretch, so no place is in two.
   */
  function ranges(text, words) {
    var found = [];
    for (var i = 0; i < words.length; i++) {
      var finder = typeof words[i] === "string" && words[i] !== "" ? pattern(words[i]) : null;
      if (!finder) continue;
      var match;
      while ((match = finder.exec(text)) !== null) {
        // A match of no length would be found at the same place for ever.
        if (match[0].length === 0) {
          finder.lastIndex++;
          continue;
        }
        found.push([match.index, match.index + match[0].length]);
        // The same word may be found again inside what was just found ("ana" twice in "banana"): look on from
        // one character after the start, a pair of code units being one character.
        var first = text.charCodeAt(match.index);
        var second = text.charCodeAt(match.index + 1);
        finder.lastIndex = match.index + (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff ? 2 : 1);
      }
    }
    found.sort(function (a, b) {
      return a[0] - b[0] || a[1] - b[1];
    });
    var joined = [];
    for (var j = 0; j < found.length; j++) {
      var last = joined[joined.length - 1];
      if (last && found[j][0] <= last[1]) last[1] = Math.max(last[1], found[j][1]);
      else joined.push([found[j][0], found[j][1]]);
    }
    return joined;
  }

  /** The whole text as pieces in order, each either found or not. Put together again they are the text. */
  function pieces(text, words) {
    var parts = [];
    var at = 0;
    var marks = ranges(text, words);
    for (var i = 0; i < marks.length; i++) {
      if (marks[i][0] > at) parts.push({ text: text.slice(at, marks[i][0]), marked: false });
      parts.push({ text: text.slice(marks[i][0], marks[i][1]), marked: true });
      at = marks[i][1];
    }
    if (at < text.length) parts.push({ text: text.slice(at), marked: false });
    return parts;
  }

  scope.vigileMarks = { ranges: ranges, pieces: pieces };
})(typeof window === "undefined" ? globalThis : window);

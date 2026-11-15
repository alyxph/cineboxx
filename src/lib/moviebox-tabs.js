// tab-operating returns either titles directly or sections with nested title lists.
export function tabSubjects(data) {
  const subjects = [];
  const visit = (node) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== 'object') return;
    if (/FILTER|SINGLE_IMAGE|ACTOR|STAR/i.test(String(node.type || ''))) return;
    if (node.hasResource === false && node.subject) return;
    const subject = node.subject || node.info || node;
    if (subject.subjectId && (subject.title || subject.name)) {
      if ([1, 2].includes(Number(subject.subjectType ?? 1))) subjects.push(subject);
      return;
    }
    for (const key of ['list', 'items', 'subjects', 'movieList', 'customData', 'banner', 'banners', 'rankingListData', 'sections']) {
      visit(node[key]);
    }
  };
  visit(data);
  return subjects;
}

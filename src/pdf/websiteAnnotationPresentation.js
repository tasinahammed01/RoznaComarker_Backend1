'use strict';
const rules = require('./websiteAnnotationRules.generated');
const { fallbackLegend } = require('../services/correctionLegendResolver.service');
const colors = Object.fromEntries(fallbackLegend().groups.map(g => [g.key, g.color]));
const id = c => String(c.reportId || c.id || c._id || '');
/** CPU-only website rule adapter. No DOM, providers, source edits or persisted writes. */
function websiteAnnotationPresentation(page) {
    const source = page.annotationSourceGeometry || null;
    const swap = source?.coordinateSpace === 'encoded-image' && [6, 8].includes(source.orientation);
    const width = Number(source ? (swap ? source.height : source.width) : page.imageWidth) || 900;
    const height = Number(source ? (swap ? source.width : source.height) : page.imageHeight) || 1200;
    const pageNumber = Number(page.pageNumber) || 1;
    const corrections = page.corrections || [], byId = new Map(corrections.map(c => [id(c), c]));
    const annotations = corrections.map(c => ({ ...c, _id: id(c), page: c.page || pageNumber,
        color: c.color || colors[c.category] || '#d64545', bboxList: c.bboxList || c.targetBoxes || [] }));
    // Asset optimization may resize, but cannot legitimately change source aspect ratio.
    const aspectMatches = !source || !(page.imageWidth > 0 && page.imageHeight > 0)
        || Math.abs((page.imageWidth / page.imageHeight) / (width / height) - 1) < 0.01;
    const presentation = source && (!aspectMatches || !rules.sourceGeometryMatchesImage(source, page.fileId, pageNumber, width, height))
        ? { annotations: [], words: [] } : rules.imagePresentationGeometry(annotations, page.annotationWords || page.words || [], source, page.fileId, pageNumber, width, height);
    const visuals = rules.buildAnnotationVisuals(presentation.annotations, presentation.words, pageNumber, width, height);
    // A fixed desktop reference freezes membership/label decisions before static
    // mm scaling. PDF thumbnail size must not create additional collision groups.
    const referenceWidth = 900, referenceHeight = referenceWidth * height / width;
    const placed = rules.layoutAnnotationGroups(visuals, referenceWidth, referenceHeight, 110, undefined, presentation.words);
    const groups = placed.map(group => {
        const correctionIds = group.annotations.map(a => a._id), members = correctionIds.map(key => byId.get(key));
        const segments = visuals.filter(v => correctionIds.includes(v.annotation._id)).flatMap(v => v.segments.map(s => ({ ...s, semantic: v.semantic })));
        const identities = group.annotations.map(a => {
            const source = a.renderTarget || a.visualTarget, ids = source?.wordIds || a.wordIds || [];
            return { correctionId: a._id, wordIds: [...ids].sort(), anchors: source?.anchors || [] };
        });
        return { targetIdentity: JSON.stringify([page.fileId || '', pageNumber, identities]), correctionIds,
            symbols: [...new Set(group.annotations.map(a => a.symbol))], displayLabel: group.code,
            color: group.annotations[0].color, category: group.annotations[0].category, page: pageNumber,
            targetIds: identities, segments, members };
    });
    const represented = new Set(groups.flatMap(g => g.correctionIds));
    const strokes = [...rules.sharedSegments(visuals, false).map(s => ({ ...s, semantic: false })),
        ...rules.sharedSegments(visuals, true).map(s => ({ ...s, semantic: true }))];
    return { groups, strokes, words: presentation.words, annotations: presentation.annotations,
        unmapped: corrections.filter(c => !represented.has(id(c))), byId };
}
module.exports = { websiteAnnotationPresentation, PDF_ANNOTATION_VERSION: 'website-semantic-groups-v1' };

const {flatten} = require('wu');
const {isWhitespace, min} = require('./utils');


// Return the number of stride nodes between 2 DOM nodes *at the same
// level of the tree*, without going up or down the tree.
//
// Stride nodes are {(1) siblings or (2) siblings of ancestors} that lie
// between the 2 nodes. These interposed nodes make it less likely that the 2
// nodes should be together in a cluster.
//
// left xor right may also be undefined.
function numStrides(left, right) {
    let num = 0;

    // Walk right from left node until we hit the right node or run out:
    let sibling = left;
    let shouldContinue = sibling && sibling !== right;
    while (shouldContinue) {
        sibling = sibling.nextSibling;
        if ((shouldContinue = sibling && sibling !== right) &&
            !isWhitespace(sibling)) {
            num += 1;
        }
    }
    if (sibling !== right) {  // Don't double-punish if left and right are siblings.
        // Walk left from right node:
        sibling = right;
        while (sibling) {
            sibling = sibling.previousSibling;
            if (sibling && !isWhitespace(sibling)) {
                num += 1;
            }
        }
    }
    return num;
}


// Return a distance measurement between 2 DOM nodes.
//
// I was thinking of something that adds little cost for siblings.
// Up should probably be more expensive than down (see middle example in the Nokia paper).
// O(n log n)
function distance(elementA, elementB) {
    // TODO: Test and tune these costs. They're off-the-cuff at the moment.
    //
    // Cost for each level deeper one node is than the other below their common
    // ancestor:
    const DIFFERENT_DEPTH_COST = 2;
    // Cost for a level below the common ancestor where tagNames differ:
    const DIFFERENT_TAG_COST = 2;
    // Cost for a level below the common ancestor where tagNames are the same:
    const SAME_TAG_COST = 1;
    // Cost for each stride node between A and B:
    const STRIDE_COST = 1;

    if (elementA === elementB) {
        return 0;
    }

    // Stacks that go from the common ancestor all the way to A and B:
    const aAncestors = [elementA];
    const bAncestors = [elementB];

    let aAncestor = elementA;
    let bAncestor = elementB;

    // Ascend to common parent, stacking them up for later reference:
    while (!aAncestor.contains(elementB)) {  // Note: an element does contain() itself.
        aAncestor = aAncestor.parentNode;
        aAncestors.push(aAncestor);
    }

    // Make an ancestor stack for the right node too so we can walk
    // efficiently down to it:
    do {
        bAncestor = bAncestor.parentNode;  // Assumes we've early-returned above if A === B.
        bAncestors.push(bAncestor);
    } while (bAncestor !== aAncestor);

    // Figure out which node is left and which is right, so we can follow
    // sibling links in the appropriate directions when looking for stride
    // nodes:
    let left = aAncestors;
    let right = bAncestors;
    // In compareDocumentPosition()'s opinion, inside implies after. Basically,
    // before and after pertain to opening tags.
    const comparison = elementA.compareDocumentPosition(elementB);
    let cost = 0;
    let mightStride;
    if (comparison & elementA.DOCUMENT_POSITION_FOLLOWING) {
        // A is before, so it could contain the other node.
        mightStride = !(comparison & elementA.DOCUMENT_POSITION_CONTAINED_BY);
        left = aAncestors;
        right = bAncestors;
    } else if (comparison & elementA.DOCUMENT_POSITION_PRECEDING) {
        // A is after, so it might be contained by the other node.
        mightStride = !(comparison & elementA.DOCUMENT_POSITION_CONTAINS);
        left = bAncestors;
        right = aAncestors;
    }

    // Descend to both nodes in parallel, discounting the traversal
    // cost iff the nodes we hit look similar, implying the nodes dwell
    // within similar structures.
    while (left.length || right.length) {
        const l = left.pop();
        const r = right.pop();
        if (l === undefined || r === undefined) {
            // Punishment for being at different depths: same as ordinary
            // dissimilarity punishment for now
            cost += DIFFERENT_DEPTH_COST;
        } else {
            // TODO: Consider similarity of classList.
            cost += l.tagName === r.tagName ? SAME_TAG_COST : DIFFERENT_TAG_COST;
        }
        // Optimization: strides might be a good dimension to eliminate.
        if (mightStride) {
            cost += numStrides(l, r) * STRIDE_COST;
        }
    }

    return cost;
}


// A lower-triangular matrix of inter-cluster distances
// TODO: Allow distance function to be passed in, making this generally useful
// and not tied to the DOM.
class DistanceMatrix {
    constructor(elements) {
        // A sparse adjacency matrix:
        // {A => {},
        //  B => {A => 4},
        //  C => {A => 4, B => 4},
        //  D => {A => 4, B => 4, C => 4}
        //  E => {A => 4, B => 4, C => 4, D => 4}}
        //
        // A, B, etc. are arrays of [arrays of arrays of...] DOM nodes, each
        // array being a cluster. In this way, they not only accumulate a
        // cluster but retain the steps along the way.
        //
        // This is an efficient data structure in terms of CPU and memory, in
        // that we don't have to slide a lot of memory around when we delete a
        // row or column from the middle of the matrix while merging. Of
        // course, we lose some practical efficiency by using hash tables, and
        // maps in particular are slow in their early implementations.
        this._matrix = new Map();

        // Convert elements to clusters:
        const clusters = elements.map(el => [el]);

        // Init matrix:
        for (let outerCluster of clusters) {
            const innerMap = new Map();
            for (let innerCluster of this._matrix.keys()) {
                innerMap.set(innerCluster, distance(outerCluster[0],
                                                    innerCluster[0]));
            }
            this._matrix.set(outerCluster, innerMap);
        }
        this._numClusters = clusters.length;
    }

    // Return (distance, a: clusterA, b: clusterB) of closest-together clusters.
    // Replace this to change linkage criterion.
    closest() {
        const self = this;

        if (this._numClusters < 2) {
            throw new Error('There must be at least 2 clusters in order to return the closest() ones.');
        }

        // Return the distances between every pair of clusters.
        function *clustersAndDistances() {
            for (let [outerKey, row] of self._matrix.entries()) {
                for (let [innerKey, storedDistance] of row.entries()) {
                    yield {a: outerKey, b: innerKey, distance: storedDistance};
                }
            }
        }
        return min(clustersAndDistances(), x => x.distance);
    }

    // Look up the distance between 2 clusters in me. Try the lookup in the
    // other direction if the first one falls in the nonexistent half of the
    // triangle.
    _cachedDistance(clusterA, clusterB) {
        let ret = this._matrix.get(clusterA).get(clusterB);
        if (ret === undefined) {
            ret = this._matrix.get(clusterB).get(clusterA);
        }
        return ret;
    }

    // Merge two clusters.
    merge(clusterA, clusterB) {
        // An example showing how rows merge:
        //  A: {}
        //  B: {A: 1}
        //  C: {A: 4, B: 4},
        //  D: {A: 4, B: 4, C: 4}
        //  E: {A: 4, B: 4, C: 2, D: 4}}
        //
        // Step 2:
        //  C: {}
        //  D: {C: 4}
        //  E: {C: 2, D: 4}}
        //  AB: {C: 4, D: 4, E: 4}
        //
        // Step 3:
        //  D:  {}
        //  AB: {D: 4}
        //  CE: {D: 4, AB: 4}

        // Construct new row, finding min distances from either subcluster of
        // the new cluster to old clusters.
        //
        // There will be no repetition in the matrix because, after all,
        // nothing pointed to this new cluster before it existed.
        const newRow = new Map();
        for (let outerKey of this._matrix.keys()) {
            if (outerKey !== clusterA && outerKey !== clusterB) {
                newRow.set(outerKey, Math.min(this._cachedDistance(clusterA, outerKey),
                                              this._cachedDistance(clusterB, outerKey)));
            }
        }

        // Delete the rows of the clusters we're merging.
        this._matrix.delete(clusterA);
        this._matrix.delete(clusterB);

        // Remove inner refs to the clusters we're merging.
        for (let inner of this._matrix.values()) {
            inner.delete(clusterA);
            inner.delete(clusterB);
        }

        // Attach new row.
        this._matrix.set([clusterA, clusterB], newRow);

        // There is a net decrease of 1 cluster:
        this._numClusters -= 1;
    }

    numClusters() {
        return this._numClusters;
    }

    // Return an Array of nodes for each cluster in me.
    clusters() {
        // TODO: Can't get wu.map to work here. Don't know why.
        return Array.from(this._matrix.keys()).map(e => Array.from(flatten(false, e)));
    }
}


// Partition the given nodes into one or more clusters by position in the DOM
// tree.
//
// elements: An Array of DOM nodes
// tooFar: The closest-nodes distance() beyond which we will not attempt to
//     unify 2 clusters
//
// This implements an agglomerative clustering. It uses single linkage, since
// we're talking about adjacency here more than Euclidean proximity: the
// clusters we're talking about in the DOM will tend to be adjacent, not
// overlapping. We haven't tried other linkage criteria yet.
//
// Maybe later we'll consider score or notes.
function clusters(elements, tooFar) {
    const matrix = new DistanceMatrix(elements);
    let closest;

    while (matrix.numClusters() > 1 && (closest = matrix.closest()).distance < tooFar) {
        matrix.merge(closest.a, closest.b);
    }

    return matrix.clusters();
}


module.exports = {
    clusters,
    distance
};

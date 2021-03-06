// The right-hand side of a rule

const {NiceSet, reversed} = require('./utils');


const TYPE = 1;
const NOTE = 2;
const SCORE = 4;
const ELEMENT = 8;
const CONSERVE_SCORE = 16;
const SUBFACTS = {
    type: TYPE,
    note: NOTE,
    score: SCORE,
    element: ELEMENT,
    conserveScore: CONSERVE_SCORE
};


function out(key) {
    return new OutwardRhs(key);
}


// A right-hand side is a strung-together series of calls like
// `type('smoo').props(blah).type('whee').score(2)`. Calls layer together like
// sheets of transparent acetate: if there are repeats, as with `type()` in the
// previous example, the rightmost takes precedence. Similarly, if `props()`,
// which can return multiple properties of a fact (element, note, score, and
// type), is missing any of these properties, we continue searching to the left
// for anything that provides them (excepting other props() calls--if you want
// that, write a combinator, and use it to combine the 2 functions you want)).
// To prevent this, return all properties explicitly from your props callback,
// even if they are no-ops (like {score: 1, note: undefined, type: undefined}).
class InwardRhs {
    constructor(calls = [], max = Infinity, types) {
        this._calls = calls.slice();
        this._max = max;
        this._types = new NiceSet(types);  // empty set if unconstrained
    }

    // Declare that the maximum returned score multiplier is such and such.
    // This doesn't force it to be true; it merely throws an error if it isn't.
    // This overrides any previous call to .atMost(). To lift an .atMost()
    // constraint, call .atMost() with no args.
    atMost(score) {
        return new this.constructor(this._calls, score, this._types);
    }

    _checkScoreUpTo(fact) {
        if (fact.score !== undefined && fact.score > this._max) {
            throw new Error(`Score of ${fact.score} exceeds the declared atMost(${this._max}).`);
        }
    }

    // Determine any of type, note, score, and element using a callback.
    // This overrides any previous call to .props() and, depending on what
    // properties of the callback's return value are filled out, may override
    // the effects of other previous calls as well.
    props(callback) {
        function getSubfacts(fnode) {
            const subfacts = callback(fnode);
            // Filter the raw result down to okayed properties so callbacks
            // can't insert arbitrary keys (like conserveScore, which might
            // mess up the optimizer).
            for (let subfact in subfacts) {
                if (!SUBFACTS.hasOwnProperty(subfact) || !(SUBFACTS[subfact] & getSubfacts.possibleSubfacts)) {
                    // The ES5.1 spec says in 12.6.4 that it's fine to delete
                    // as we iterate.
                    delete subfacts[subfact];
                }
            }
            return subfacts;
        }
        // Thse are the subfacts this call could affect:
        getSubfacts.possibleSubfacts = TYPE | NOTE | SCORE | ELEMENT;
        getSubfacts.kind = 'props';
        return new this.constructor(this._calls.concat(getSubfacts),
                                    this._max,
                                    this._types);
    }

    // Set the type applied to fnodes processed by this RHS. This overrides any
    // previous call to .type().
    //
    // In the future, we might also support providing a callback that receives
    // the fnode and returns a type. We couldn't reason based on these, but the
    // use would be rather a consise way to to override part of what a previous
    // .props() call provides.
    type(type) {
        // Actually emit a given type.
        function getSubfacts() {
            return {type};
        }
        getSubfacts.possibleSubfacts = TYPE;
        getSubfacts.type = type;
        getSubfacts.kind = 'type';
        return new this.constructor(this._calls.concat(getSubfacts),
                                    this._max,
                                    this._types);
    }

    // Constrain us to emit 1 of a set of given types. This overrides any
    // previous call to .typeIn(). Pass no args to lift a previous typeIn()
    // constraint.
    //
    // This is mostly a hint for the optimizer when you're emitting types
    // dynamically from functions, but it also checks conformance at runtime to
    // ensure validity.
    //
    // Rationale: If we used the spelling "type('a', 'b', ...)" instead of
    // this, one might expect type('a', 'b').type(fn) to have the latter call
    // override, while expecting type(fn).type('a', 'b') to keep both in
    // effect. Then different calls to type() don't consistently override each
    // other, and the rules get complicated. Plus you can't inherit a type
    // constraint and then sub in another type-returning function that still
    // gets the constraint applied.
    typeIn(...types) {
        return new this.constructor(this._calls,
                                    this._max,
                                    types);
    }

    // Check a fact for conformance with any typeIn() call.
    //
    // leftType: the type of the LHS, which becomes my emitted type if the fact
    //     doesn't specify one
    _checkTypeIn(result, leftType) {
        if (this._types.size > 0) {
            if (result.type === undefined) {
                if (!this._types.has(leftType)) {
                    throw new Error(`A right-hand side claimed, via typeIn(...) to emit one of the types ${this._types} but actually inherited ${leftType} from the left-hand side.`);
                }
            } else if (!this._types.has(result.type)) {
                throw new Error(`A right-hand side claimed, via typeIn(...) to emit one of the types ${this._types} but actually emitted ${result.type}.`);
            }
        }
    }

    // Whatever the callback returns (even undefined) becomes the note of the
    // fact. This overrides any previous call to .note().
    //
    // When you query for fnodes of a certain type, you can expect to find
    // notes of any form you specified on any RHS with that type. If no note is
    // specified, it will be undefined. However, if two RHSs emits a given
    // type, one adding a note and the other not adding one (or adding an
    // undefined one), the meaningful note overrides the undefined one.
    note(callback) {
        function getSubfacts(fnode) {
            return {note: callback(fnode)};
        }
        getSubfacts.possibleSubfacts = NOTE;
        getSubfacts.kind = 'note';
        return new this.constructor(this._calls.concat(getSubfacts),
                                    this._max,
                                    this._types);
    }

    // Set the returned score multiplier. This overrides any previous calls to
    // .score().
    //
    // scoreOrCallback: Either a number (which will be multiplied into the
    //   score for each fnode emitted from the LHS) or a function that take a
    //   fnode and returns such a number
    //
    // In the future, we might also support providing a callback that receives
    // the fnode and returns a score. We couldn't reason based on these, but
    // the use would be rather to override part of what a previous .props() call
    // provides. It would also allow us to avoid some uses of props(), which
    // force us to verbosely declare typeIn().
    score(scoreOrCallback) {
        let getSubfacts;

        function getSubfactsFromNumber(fnode) {
            return {score: scoreOrCallback};
        }

        function getSubfactsFromFunction(fnode) {
            return {score: scoreOrCallback(fnode)};
        }

        if (typeof scoreOrCallback === 'number') {
            getSubfacts = getSubfactsFromNumber;
        } else {
            getSubfacts = getSubfactsFromFunction;
        }
        getSubfacts.possibleSubfacts = SCORE;
        getSubfacts.kind = 'score';

        return new this.constructor(this._calls.concat(getSubfacts),
                                    this._max,
                                    this._types);
    }

    // Rig this RHS to base the scores it applies off the scores of the input
    // nodes rather than just starting from 1.
    //
    // For now, there is no way to turn this back off, for example with a later
    // application of .props() or .conserveScore(false). We can add one if
    // necessary.
    conserveScore() {
        function getSubfacts(fnode) {
            return {conserveScore: true};
        }
        getSubfacts.possibleSubfacts = CONSERVE_SCORE;
        getSubfacts.kind = 'conserveScore';
        return new this.constructor(this._calls.concat(getSubfacts),
                                    this._max,
                                    this._types);
    }

    // Future: why not have an .element() method for completeness?

    // -------- Methods below this point are private to the framework. --------

    // Run all my props().type().note().score() stuff across a given fnode,
    // enforce my max() stuff, and return a fact ({element, type, score,
    // notes}) for incorporation into that fnode (or a different one, if
    // element is specified). Any of the 4 fact properties can be missing;
    // filling in defaults is a job for the caller.
    //
    // leftType: the type the LHS takes in
    fact(fnode, leftType) {
        const doneKinds = new Set();
        const result = {};
        let haveSubfacts = 0;
        for (let call of reversed(this._calls)) {
            // If we've already called a call of this kind, then forget it.
            if (!doneKinds.has(call.kind)) {
                doneKinds.add(call.kind);

                if (~haveSubfacts & call.possibleSubfacts) {
                    // This call might provide a subfact we are missing.
                    const newSubfacts = call(fnode);
                    for (let subfact in newSubfacts) {
                        // A props() callback could insert arbitrary keys into
                        // the result, but it shouldn't matter, because nothing
                        // pays any attention to them.
                        if (!result.hasOwnProperty(subfact)) {
                            result[subfact] = newSubfacts[subfact];
                        }
                        haveSubfacts |= SUBFACTS[subfact];
                    }
                }
            }
        }
        this._checkScoreUpTo(result);
        this._checkTypeIn(result, leftType);
        return result;
    }

    // Return a record describing the types I might emit (which means either to
    // add a type to a fnode or to output a fnode that already has that type).
    // {couldChangeType: whether I might add a type to the fnode,
    //  possibleTypes: If couldChangeType, the types I might emit; empty set if
    //      we cannot infer it. If not couldChangeType, undefined.}
    possibleEmissions() {
        // If there is a typeIn() constraint or there is a type() call to the
        // right of all props() calls, we have a constraint. We hunt for the
        // tightest constraint we can find, favoring a type() call because it
        // gives us a single type but then falling back to a typeIn().
        let couldChangeType = false;
        for (let call of reversed(this._calls)) {
            if (call.kind === 'props') {
                couldChangeType = true;
                break;
            } else if (call.kind === 'type') {
                return {couldChangeType: true,
                        possibleTypes: new Set([call.type])};
            }
        }
        return {couldChangeType,
                possibleTypes: this._types};
    }
}


class OutwardRhs {
    constructor(key, through = x => x) {
        this.key = key;
        this.callback = through;
    }

    through(callback) {
        return new this.constructor(this.key, callback);
    }

    asRhs() {
        return this;
    }
}


module.exports = {
    InwardRhs,
    out,
    OutwardRhs
};

// A dictionary VR cannot decode an on-wire UN value of incompatible size.
// Keep those bytes unknown instead of reading into the next element or
// inventing a numeric metadata value. Empty values and valid multiples work.
function localUnHasIncompatibleNumericLength(type, length) {
  var resolved = ValueRepresentation.createByTypeString(type);
  return length > 0 && length !== 0xffffffff && resolved.fixed &&
    resolved.isBinary() && resolved.maxLength > 0 && length % resolved.maxLength !== 0;
}

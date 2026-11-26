              // Group length. The dictionary length is absent for variable
              // length group 0 (command set) elements, which some exporters
              // write at the start of the dataset; skip the parsed length so
              // the stream offset stays valid instead of becoming NaN.
              const localGroupSkip = typeof tagObj.length === "number" ? tagObj.length : length;
              if (!Number.isFinite(localGroupSkip) || localGroupSkip === UNDEFINED_LENGTH_FIX) {
                throw new Error(`Cannot skip group 0 element ${tag} with length ${length}`);
              }
              stream.increment(localGroupSkip);
              return _context5.abrupt("continue", 1);

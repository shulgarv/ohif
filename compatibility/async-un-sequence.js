    value: async function readSequence(listener, sqTagInfo, options) {
      const stream = this.stream;
      const outerSyntax = this.syntax;
      const outerLittleEndian = stream.isLittleEndian;
      // DICOM PS3.5 6.2.2 / CP-246: a sequence carried as UN contains
      // Implicit VR Little Endian data, regardless of its enclosing syntax.
      if (sqTagInfo.originalVR === "UN") {
        this.syntax = IMPLICIT_LITTLE_ENDIAN;
        stream.setEndian(true);
      }
      try {
        const length = sqTagInfo.length;
        const endOffset = length === UNDEFINED_LENGTH_FIX
          ? Number.MAX_SAFE_INTEGER : stream.offset + length;
        while (stream.offset < endOffset && await stream.ensureAvailable()) {
          const tagInfo = this.readTagHeader(options);
          if (tagInfo.tag === TagHex.Item) {
            listener.startObject();
            const itemUntilOffset = tagInfo.length === UNDEFINED_LENGTH_FIX
              ? endOffset : Math.min(stream.offset + tagInfo.length, endOffset);
            await this.read(listener, {...options, untilOffset: itemUntilOffset});
          } else if (tagInfo.tag === TagHex.SequenceDelimitationEnd) {
            return;
          } else {
            throw new Error("Unexpected tag in DICOM sequence: " + tagInfo.tag);
          }
        }
      } finally {
        this.syntax = outerSyntax;
        stream.setEndian(outerLittleEndian);
      }
    }

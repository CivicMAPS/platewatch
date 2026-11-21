package au.techcorp.platewatch;

import static org.junit.Assert.*;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;
import org.junit.Test;

/** Runs the vectors shared with tests/plateRules.test.ts so the native and web readers agree. */
public class PlateRulesTest {

    private static List<String> vectors() throws Exception {
        // Gradle runs unit tests from android/app; the vectors live in the web project's tests.
        File f = new File("../../tests/fixtures/plate-readings.tsv");
        if (!f.exists()) f = new File("tests/fixtures/plate-readings.tsv");
        return Files.readAllLines(f.toPath(),StandardCharsets.UTF_8);
    }

    @Test public void sharedVectors() throws Exception {
        int checked = 0;
        for (String line:vectors()) {
            if (line.isBlank() || line.startsWith("#")) continue;
            String[] c = line.split("\t");
            String canonical = PlateRules.canonical(c[0]);
            assertEquals("canonical "+c[0],c[1],canonical);
            assertEquals("auto-capture "+c[0],"yes".equals(c[2]),PlateRules.autoCapture(canonical));
            checked++;
        }
        assertTrue("vectors read",checked>20);
    }

    @Test public void variants() {
        assertTrue(PlateRules.variant("1UR6YF","1UP6YF"));
        assertTrue(PlateRules.variant("1UR6YF","1UD6YF"));
        assertTrue(PlateRules.variant("EDA8899","EDAB899"));
        assertTrue(PlateRules.variant("EDA8899","DA8899"));
        assertTrue(PlateRules.variant("ABO123","AB0123"));
        assertFalse(PlateRules.variant("1UR6YF","2FE70T"));
        assertFalse(PlateRules.variant("ZAF402","1XA5PL"));
        assertFalse(PlateRules.variant("ABC123","ABC789"));
    }
}

package au.techcorp.platewatch;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(android.os.Bundle state) {
        registerPlugin(PatrolCamera.class);
        super.onCreate(state);
    }
}

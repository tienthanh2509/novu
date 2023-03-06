import React, { useEffect } from 'react';

import { QuickStartWrapper } from '../components/QuickStartWrapper';
import { CheckCircleBroken } from '../../../design-system/icons/gradient/CheckCircleBroken';
import { TestNotificationTrigger } from '../components/TestNotificationTrigger';
import { BellGradient } from '../../../design-system/icons';
import { useSegment } from '../../../components/providers/SegmentProvider';
import { OnBoardingAnalyticsEnum } from '../consts';

export function Trigger() {
  const segment = useSegment();

  useEffect(() => {
    segment.track(OnBoardingAnalyticsEnum.TRIGGER_VISIT);
  }, []);

  return (
    <QuickStartWrapper
      title={<CheckCircleBroken style={{ height: '75px', width: '75px', marginTop: '100px' }} />}
      secondaryTitle={'Amazing, nearly done!'}
      description={<TriggerDescription />}
      faq={true}
    >
      <TestNotificationTrigger />
    </QuickStartWrapper>
  );
}

export function TriggerDescription() {
  return (
    <span>
      Now let's ring the bell in your new notification center
      <BellGradient style={{ margin: '0px 5px 0', top: '8px', position: 'relative' }} />
    </span>
  );
}

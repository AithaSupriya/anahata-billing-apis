import { CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { HostedZone, type IHostedZone } from 'aws-cdk-lib/aws-route53';
import { AnahataCommonStack, AnahataStage, type CommonStackProps } from '@anahata/cdk-commons';

/**
 * DnsStack — Creates a Route53 hosted zone for the billing API subdomain.
 */
export class DnsStack extends AnahataCommonStack {
  public readonly hostedZone: IHostedZone;
  public readonly zoneName: string;

  constructor(scope: Construct, id: string, props: CommonStackProps) {
    super(scope, id, props);

    const parentZone = props.env.stage === AnahataStage.PROD ? 'anahata.ai' : 'sandbox.anahata.ai';
    this.zoneName = `billing-api.${parentZone}`;

    this.hostedZone = new HostedZone(this, 'BillingApiHostedZone', {
      zoneName: this.zoneName,
      comment: `Billing Platform API DNS zone for ${this.zoneName}`,
    });

    new CfnOutput(this, 'HostedZoneId', {
      value: this.hostedZone.hostedZoneId,
      description: `Hosted Zone ID for ${this.zoneName}`,
      exportName: `${this.stackName}-HostedZoneId`,
    });
  }
}
